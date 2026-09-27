import { client, methods, ndJsonStream, PROTOCOL_VERSION, RequestError, type AnyMessage, type NewSessionResponse } from "@agentclientprotocol/sdk";
import { spawn } from "node:child_process";
import { appendFileSync, closeSync, openSync } from "node:fs";
import { Writable } from "node:stream";
import { ReadableStream } from "node:stream/web";
import { version } from "../package.json";
import type { ProviderSpec } from "./providers.ts";

const startupMs = 5 * 60_000;
const lineLimit = 64 * 1024 ** 2;
const lastMessageLength = 300;

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

export async function openSession(opts: { container: string; provider: ProviderSpec; transcript: string; adapterLog: string }): Promise<Session> {
  const argv = ["docker", "exec", "-i", "-w", "/qa/out", opts.container, ...opts.provider.adapter];
  const log = openSync(opts.adapterLog, "a");
  const child = spawn("docker", argv.slice(1), { stdio: ["pipe", "pipe", log] });
  closeSync(log);
  const { stdin, stdout } = child;
  if (stdin === null || stdout === null) throw new Error(`${argv.join(" ")} started without stdio pipes`);
  const exited = new Promise<void>((resolve) => {
    child.once("exit", () => resolve());
    child.once("close", () => resolve());
  });

  const record = (from: "client" | "agent", message: AnyMessage) =>
    appendFileSync(opts.transcript, `${JSON.stringify({ t: new Date().toISOString(), from, message })}\n`);
  const overlong = new Error(`${argv.join(" ")} printed more than ${lineLimit / 1024 ** 2} MiB without a newline`);
  let unterminated = 0;
  const lines = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      const newline = chunk.lastIndexOf(0x0a);
      unterminated = newline === -1 ? unterminated + chunk.byteLength : chunk.byteLength - newline - 1;
      if (unterminated > lineLimit) throw overlong;
      controller.enqueue(chunk);
    },
  });
  const wire = ndJsonStream(Writable.toWeb(stdin), ReadableStream.from<Uint8Array>(stdout).pipeThrough(lines));
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

  let closing: Promise<void> | undefined;
  const close = () =>
    (closing ??= (async () => {
      stdin.end();
      const kill = setTimeout(() => child.kill("SIGKILL"), 10_000);
      await exited;
      clearTimeout(kill);
      connection.close();
    })());

  const failure = async (error: unknown) => {
    if (error instanceof RequestError) return new AgentError(error.code, error.message, error.data);
    await close();
    if (error === overlong) return overlong;
    const stderr = (await Bun.file(opts.adapterLog).text()).slice(-2000);
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
        const drain = async () => {
          for (;;) {
            const message = await session.nextUpdate();
            if (message.kind === "stop") return;
            if (message.update.sessionUpdate === "tool_call") toolCalls += 1;
            if (message.update.sessionUpdate === "agent_message_chunk" && message.update.content.type === "text") {
              lastMessage = (lastMessage + message.update.content.text).slice(0, lastMessageLength);
            }
          }
        };
        try {
          const [response] = await Promise.all([session.prompt(text), drain()]);
          return { stopReason: response.stopReason, toolCalls, lastMessage };
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
