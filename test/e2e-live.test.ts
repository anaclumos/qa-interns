import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { removeDir, writeChromePolicy } from "../src/environment.ts";
import { ask } from "../src/run.ts";
import { ensureRunnerImage } from "../src/runner.ts";
import { newRunId } from "../src/state.ts";
import { dockerAvailable, leftovers, timeout } from "./e2e.ts";

describe.skipIf(!dockerAvailable)("a live intern on the Vercel AI Gateway", () => {
  test(
    "reads a number from a browser screenshot through tool calls and writes it",
    async () => {
      const key = process.env.AI_GATEWAY_API_KEY;
      if (key === undefined) throw new Error("AI_GATEWAY_API_KEY is not set, and the live intern test runs on a Vercel AI Gateway API key");
      const root = await mkdtemp(join(tmpdir(), "qair-f-live-"));
      const previousStateHome = process.env.XDG_STATE_HOME;
      process.env.XDG_STATE_HOME = join(root, "state");
      try {
        const store = join(root, "store");
        await mkdir(store);
        await Bun.write(join(store, "auth.json"), JSON.stringify({ "vercel-ai-gateway": { type: "api_key", key } }));
        const loginsFile = join(root, "logins.json");
        await Bun.write(loginsFile, JSON.stringify({ id: "gateway-ci", store }));
        const runId = newRunId();
        const runDir = join(root, "run");
        await mkdir(runDir);
        await writeChromePolicy(runDir, {});
        const number = 1000 + Math.floor(Math.random() * 9000);
        const page = Buffer.from(`<p style="font: bold 160px sans-serif">${number}</p>`).toString("base64");
        const answer = await ask({
          runDir,
          runId,
          name: "live",
          loginsFile,
          runnerImage: await ensureRunnerImage(),
          admit: () => () => {},
          prompt: [
            "Run these two commands, one at a time:",
            `agent-browser open 'data:text/html;base64,${page}'`,
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
        const toolCall = z.object({ from: z.literal("agent"), message: z.object({ params: z.object({ update: z.object({ sessionUpdate: z.literal("tool_call") }) }) }) });
        const toolCalls = transcript
          .split("\n")
          .filter((line) => line !== "")
          .filter((line) => toolCall.safeParse(JSON.parse(line)).success);
        expect(toolCalls.length).toBeGreaterThanOrEqual(3);
        expect(await leftovers(runId)).toEqual([]);
      } finally {
        if (previousStateHome === undefined) delete process.env.XDG_STATE_HOME;
        else process.env.XDG_STATE_HOME = previousStateHome;
        await removeDir(root);
      }
    },
    timeout,
  );
});
