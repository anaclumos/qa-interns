import { client, methods, ndJsonStream, PROTOCOL_VERSION, RequestError, type AnyMessage, type NewSessionResponse } from "@agentclientprotocol/sdk";
import { spawn } from "node:child_process";
import { appendFileSync, statSync } from "node:fs";
import { Writable } from "node:stream";
import { ReadableStream } from "node:stream/web";
import { z } from "zod";
import { version } from "../package.json";
import type { ProviderSpec } from "./providers.ts";
import { longestSecret, redact, redactAcross } from "./secrets.ts";

const startupMs = 5 * 60_000;
const logLimit = 64 * 1024 ** 2;
const lineLimit = 64 * 1024 ** 2;
const heldReads = 1024;
const sentLimit = 64 * 1024 ** 2;
const lastMessageLength = 300;
const chunkSchema = z.looseObject({
  method: z.literal(methods.client.session.update),
  params: z.looseObject({
    update: z.looseObject({ sessionUpdate: z.enum(["agent_message_chunk", "agent_thought_chunk"]), content: z.looseObject({ type: z.literal("text"), text: z.string() }) }),
  }),
});

export class AgentError extends Error {
  code: number;
  data: unknown;

  constructor(code: number, message: string, data: unknown) {
    super(message);
    this.name = "AgentError";
    this.code = code;
    this.data = data;
  }
}

export type Session = {
  model: string | null;
  prompt(text: string): Promise<{ stopReason: string; toolCalls: number; lastMessage: string }>;
  cancel(): Promise<void>;
  close(): Promise<void>;
};

function modelOf(response: NewSessionResponse): string | null {
  const option = response.configOptions?.find((entry) => entry.id === "model");
  if (option && typeof option.currentValue === "string") return option.currentValue;
  if (!("models" in response)) return null;
  const models = response.models;
  return typeof models === "object" && models !== null && "currentModelId" in models && typeof models.currentModelId === "string"
    ? models.currentModelId
    : null;
}

function appender(path: string): (data: string | Uint8Array) => void {
  appendFileSync(path, "");
  let room = logLimit - statSync(path).size;
  return (data) => {
    const size = Buffer.byteLength(data);
    if (size > room) {
      room = 0;
      return;
    }
    appendFileSync(path, data);
    room -= size;
  };
}

export async function openSession(opts: { container: string; provider: ProviderSpec; transcript: string; adapterLog: string }): Promise<Session> {
  const argv = ["docker", "exec", "-i", "-w", "/qa/out", opts.container, ...opts.provider.adapter];
  const log = appender(opts.adapterLog);
  const transcript = appender(opts.transcript);
  const child = spawn("docker", argv.slice(1), { stdio: "pipe" });
  const { stdin, stdout, stderr } = child;
  if (stdin === null || stdout === null || stderr === null) throw new Error(`${argv.join(" ")} started without stdio pipes`);
  const exited = Promise.all([
    new Promise<void>((resolve) => {
      child.once("exit", () => resolve());
      child.once("close", () => resolve());
    }),
    new Promise<void>((resolve) => stderr.once("close", () => resolve())),
  ]);

  const line = (t: string, from: "client" | "agent", message: unknown) => transcript(`${JSON.stringify({ t, from, message })}\n`);
  const pending: { t: string; chunk: z.infer<typeof chunkSchema> }[] = [];
  const release = (all: boolean) => {
    redactAcross(pending.map((entry) => entry.chunk.params.update.content));
    let held = 0;
    let after = 0;
    for (const entry of pending.toReversed()) {
      if (all || after >= longestSecret() - 1) break;
      after += entry.chunk.params.update.content.text.length;
      held += 1;
    }
    for (const entry of pending.splice(0, pending.length - held)) line(entry.t, "agent", entry.chunk);
  };
  const record = (from: "client" | "agent", message: AnyMessage) => {
    const t = new Date().toISOString();
    const chunk = from === "agent" ? chunkSchema.safeParse(message) : null;
    const kind = chunk?.success ? chunk.data.params.update.sessionUpdate : null;
    if (pending[0] !== undefined && pending[0].chunk.params.update.sessionUpdate !== kind) release(true);
    if (!chunk?.success) {
      line(t, from, message);
      return;
    }
    pending.push({ t, chunk: chunk.data });
    release(false);
  };
  const overlong = new Error(`${argv.join(" ")} printed more than ${lineLimit / 1024 ** 2} MiB without a newline`);
  const oversent = new Error(`qa-interns sent more than ${sentLimit / 1024 ** 2} MiB to ${argv.join(" ")}`);
  let unterminated = 0;
  let held: Uint8Array[] = [];
  const lines = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      for (let start = 0; ; ) {
        const newline = chunk.indexOf(0x0a, start);
        unterminated += (newline === -1 ? chunk.byteLength : newline) - start;
        if (unterminated > lineLimit) throw overlong;
        if (newline === -1) break;
        unterminated = 0;
        start = newline + 1;
      }
      held.push(chunk);
      if (held.length < heldReads && !chunk.includes(0x0a)) return;
      controller.enqueue(held.length === 1 ? chunk : Buffer.concat(held));
      held = [];
    },
    flush(controller) {
      if (held.length > 0) controller.enqueue(Buffer.concat(held));
    },
  });
  let sent = 0;
  const stdinWriter = Writable.toWeb(stdin).getWriter();
  const input = new WritableStream<Uint8Array>({
    write(bytes) {
      sent += bytes.byteLength;
      if (sent > sentLimit) throw oversent;
      return stdinWriter.write(bytes);
    },
  });
  const wire = ndJsonStream(input, ReadableStream.from<Uint8Array>(stdout).pipeThrough(lines));
  const writer = wire.writable.getWriter();
  let turn: string | number | null | undefined;
  const stream = {
    writable: new WritableStream<AnyMessage>({
      write(message) {
        record("client", message);
        if ("method" in message && "id" in message && message.method === methods.agent.session.prompt) turn = message.id;
        return writer.write(message);
      },
    }),
    readable: wire.readable.pipeThrough(
      new TransformStream<AnyMessage, AnyMessage>({
        transform(message, controller) {
          record("agent", message);
          if ("method" in message) {
            if (message.method === methods.client.session.update && turn === undefined) return;
          } else if (message.id === turn) {
            turn = undefined;
          }
          controller.enqueue(message);
        },
      }),
    ),
  };

  const connection = client({ name: "qa-interns" })
    .onRequest(methods.client.session.requestPermission, ({ params }) => {
      const option =
        params.options.find((entry) => entry.kind === "allow_once") ?? params.options.find((entry) => entry.kind === "allow_always");
      return { outcome: option ? { outcome: "selected", optionId: option.optionId } : { outcome: "cancelled" } };
    })
    .connect(stream);
  child.once("error", (error) => connection.close(error));
  stderr.on("data", (data: Buffer) => {
    try {
      log(data);
    } catch (error) {
      connection.close(error);
    }
  });

  let closing: Promise<void> | undefined;
  const close = () =>
    (closing ??= (async () => {
      stdin.end();
      const kill = setTimeout(() => child.kill("SIGKILL"), 10_000);
      await exited;
      clearTimeout(kill);
      connection.close();
      release(true);
    })());

  const failure = async (error: unknown) => {
    if (error instanceof RequestError) return new AgentError(error.code, error.message, error.data);
    await close();
    if (error === overlong || error === oversent) return error;
    const stderr = redact(await Bun.file(opts.adapterLog).text()).slice(-2000);
    return new Error(`${argv.join(" ")} exited with ${child.exitCode ?? child.signalCode}: ${stderr}`, { cause: error });
  };

  const setup = async () => {
    await connection.agent.request(methods.agent.initialize, {
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      clientInfo: { name: "qa-interns", version },
    });
    const started = await connection.agent
      .buildSession({ cwd: "/qa/out", mcpServers: [], _meta: opts.provider.sessionMeta ?? undefined })
      .start();
    if (opts.provider.modeId !== null) {
      await connection.agent.request(methods.agent.session.setMode, { sessionId: started.sessionId, modeId: opts.provider.modeId });
    }
    return started;
  };

  const timedOut = new Error(`${argv.join(" ")} did not start a session within ${startupMs / 1000} seconds`);
  try {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(timedOut), startupMs);
    });
    const session = await Promise.race([setup(), expired]).finally(() => clearTimeout(timer));

    return {
      model: modelOf(session.newSessionResponse),
      async prompt(text) {
        let toolCalls = 0;
        let lastMessage = "";
        let complete = false;
        const drain = async () => {
          for (;;) {
            const message = await session.nextUpdate();
            if (message.kind === "stop") return;
            if (message.update.sessionUpdate === "tool_call") toolCalls += 1;
            if (!complete && message.update.sessionUpdate === "agent_message_chunk" && message.update.content.type === "text") {
              lastMessage += message.update.content.text;
              complete = redact(lastMessage).length >= lastMessageLength + 2 * longestSecret();
            }
          }
        };
        try {
          const [response] = await Promise.all([session.prompt(text), drain()]);
          return { stopReason: response.stopReason, toolCalls, lastMessage: redact(lastMessage).slice(0, lastMessageLength) };
        } catch (error) {
          throw await failure(error);
        }
      },
      cancel: () => connection.agent.notify(methods.agent.session.cancel, { sessionId: session.sessionId }),
      close,
    };
  } catch (error) {
    const reason = error === timedOut ? timedOut : await failure(error);
    await close();
    throw reason;
  }
}
