import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { openSession } from "../src/acp.ts";
import { freeSlot, holdRun, removeCopy, removeDir, runnerEnv, saveDisks, startEnvironment, stopProject, writeChromePolicy } from "../src/environment.ts";
import { pi } from "../src/pi.ts";
import { ask } from "../src/run.ts";
import { ensureRunnerImage } from "../src/runner.ts";
import { forgetSecrets, keepLoginKey } from "../src/secrets.ts";
import { newRunId } from "../src/state.ts";
import { execute } from "../src/target.ts";
import { dockerAvailable, leftovers, timeout } from "./e2e.ts";

function liveKey(): string {
  const key = process.env.OPENROUTER_API_KEY;
  if (key === undefined) throw new Error("OPENROUTER_API_KEY is not set, and the live intern tests run on an OpenRouter API key");
  return key;
}

async function liveStore(root: string, key: string): Promise<string> {
  const store = join(root, "store");
  await mkdir(store);
  await Bun.write(join(store, "auth.json"), JSON.stringify({ openrouter: { type: "api_key", key } }));
  return store;
}

function numberPage(number: number): string {
  return Buffer.from(`<p style="font: bold 160px sans-serif">${number}</p>`).toString("base64");
}

const toolCallLine = z.object({ from: z.literal("agent"), message: z.object({ params: z.object({ update: z.object({ sessionUpdate: z.literal("tool_call") }) }) }) });

const entrySchema = z.looseObject({
  type: z.string(),
  message: z.looseObject({ role: z.string(), usage: z.looseObject({ cacheRead: z.number() }).optional() }).optional(),
});

describe.skipIf(!dockerAvailable)("a live intern on OpenRouter", () => {
  test(
    "reads a number from a browser screenshot through tool calls and writes it",
    async () => {
      const key = liveKey();
      const root = await mkdtemp(join(tmpdir(), "qair-f-live-"));
      const previousStateHome = process.env.XDG_STATE_HOME;
      process.env.XDG_STATE_HOME = join(root, "state");
      try {
        const store = await liveStore(root, key);
        const loginsFile = join(root, "logins.json");
        await Bun.write(loginsFile, JSON.stringify({ id: "openrouter-ci", store }));
        const runId = newRunId();
        const runDir = join(root, "run");
        await mkdir(runDir);
        await writeChromePolicy(runDir, {});
        const number = 1000 + Math.floor(Math.random() * 9000);
        const answer = await ask({
          runDir,
          runId,
          name: "live",
          loginsFile,
          runnerImage: await ensureRunnerImage(),
          admit: () => () => {},
          prompt: [
            "Run these two commands, one at a time:",
            `agent-browser open 'data:text/html;base64,${numberPage(number)}'`,
            "agent-browser screenshot /qa/out/page.png",
            "Then open /qa/out/page.png with your read tool and look at the image.",
            'Write /qa/out/live.json with the JSON {"number": N}, where N is the number that the image shows.',
          ].join("\n"),
          file: "live.json",
          parse: (raw) => z.strictObject({ number: z.int() }).parse(JSON.parse(raw)),
        });
        expect(answer).toEqual({ number });
        const transcript = await readFile(join(runDir, "interns", "live", "transcript.jsonl"), "utf8");
        expect(transcript).not.toContain(key);
        const toolCalls = transcript
          .split("\n")
          .filter((line) => line !== "")
          .filter((line) => toolCallLine.safeParse(JSON.parse(line)).success);
        expect(toolCalls.length).toBeGreaterThanOrEqual(2);
        expect(await leftovers(runId)).toEqual([]);
      } finally {
        if (previousStateHome === undefined) delete process.env.XDG_STATE_HOME;
        else process.env.XDG_STATE_HOME = previousStateHome;
        await removeDir(root);
      }
    },
    timeout,
  );

  test(
    "compacts a session, reads its prompt cache, and cancels a running tool call",
    async () => {
      const key = liveKey();
      const root = await mkdtemp(join(tmpdir(), "qair-f-compact-"));
      const runId = newRunId();
      const runDir = join(root, "run");
      const name = "compact";
      const project = `qa-${runId}-${name}`;
      const held = holdRun(runId, runDir);
      const slot = await freeSlot();
      let image = "";
      try {
        keepLoginKey(key, "openrouter-ci");
        await mkdir(runDir);
        await writeChromePolicy(runDir, {});
        const store = await liveStore(root, key);
        const settings = join(root, "settings.json");
        await Bun.write(settings, JSON.stringify({ compaction: { reserveTokens: 995_000, keepRecentTokens: 3_000 } }));
        image = await ensureRunnerImage();
        const env = await startEnvironment({
          runId,
          runDir,
          name,
          slot: slot.slot,
          target: null,
          images: {},
          runner: {
            image,
            out: join(runDir, "interns", name, "out"),
            env: { ...runnerEnv({}), ...pi.env },
            mounts: [...pi.mounts(join(store, "auth.json")), { source: settings, target: "/home/qa/.pi/settings.json", readOnly: true }],
            tmpfs: pi.tmpfs,
          },
          egress: pi.egress,
        });
        const transcript = join(runDir, "interns", name, "transcript.jsonl");
        const session = await openSession({ container: env.runner, adapter: pi.adapter, model: pi.model, transcript, adapterLog: join(runDir, "interns", name, "adapter.log") });
        let cancelled: string;
        try {
          expect(session.model).toBe(pi.model);
          const number = 1000 + Math.floor(Math.random() * 9000);
          const read = await session.prompt(
            [
              "Run these two commands, one at a time:",
              `agent-browser open 'data:text/html;base64,${numberPage(number)}'`,
              "agent-browser screenshot /qa/out/page.png",
              "Then open /qa/out/page.png with your read tool and look at the image.",
              "Reply with only the number that the image shows.",
            ].join("\n"),
          );
          expect(read.stopReason).toBe("end_turn");
          expect(read.toolCalls).toBeGreaterThanOrEqual(2);
          expect(read.lastMessage).toContain(String(number));
          const long = await session.prompt("Run `seq 100000 102999` with your bash tool, then reply with only the last line it printed.");
          expect(long.stopReason).toBe("end_turn");
          const before = session.toolCalls();
          const sleeping = session.prompt("Run `sleep 300` with your bash tool, then reply with the word done.");
          const deadline = Date.now() + 120_000;
          while (session.toolCalls() === before && Date.now() < deadline) await Bun.sleep(250);
          expect(session.toolCalls()).toBeGreaterThan(before);
          await session.cancel();
          cancelled = (await sleeping).stopReason;
        } finally {
          await session.close();
        }
        expect(cancelled).toBe("cancelled");
        const entries = (await execute(["docker", "exec", env.runner, "sh", "-c", "cat /home/qa/.pi/sessions/*/*.jsonl"]))
          .split("\n")
          .filter((line) => line !== "")
          .map((line) => entrySchema.parse(JSON.parse(line)));
        expect(entries.filter((entry) => entry.type === "compaction").length).toBeGreaterThanOrEqual(1);
        const cacheReads = entries.flatMap((entry) => (entry.message?.role === "assistant" && entry.message.usage !== undefined ? [entry.message.usage.cacheRead] : []));
        expect(cacheReads.some((tokens) => tokens > 0)).toBe(true);
        expect(await readFile(transcript, "utf8")).not.toContain(key);
      } finally {
        await stopProject(project, join(runDir, "interns", name));
        if (image !== "") await removeCopy(runDir, runId, name, image);
        await saveDisks(runDir, name);
        slot.release();
        held.end();
        forgetSecrets();
        await removeDir(root);
      }
      expect(await leftovers(runId)).toEqual([]);
    },
    timeout,
  );
});
