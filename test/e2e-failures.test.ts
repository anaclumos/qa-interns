import { describe, expect, test } from "bun:test";
import { basename } from "node:path";
import { stopRun } from "../src/environment.ts";
import { runQa } from "../src/run.ts";
import { readState } from "../src/state.ts";
import { capture } from "../src/target.ts";
import { disks, dockerAvailable, endToEnd, intern, leftovers, timeout, workspaces } from "./e2e.ts";

describe.skipIf(!dockerAvailable)("end to end with the fake agent", () => {
  const { target, fakeImage, logins } = endToEnd();

  test(
    "an intern whose agent stops without a tool call, as Cursor does at its plan limit, fails, and so does a run with no other intern",
    async () => {
      const lines: string[] = [];
      const detail = 'stopped at minute 0 without a tool call: "\n\nUpgrade your plan to continue"';
      const run = runQa({
        dir: target,
        rev: "HEAD",
        dirty: false,
        interns: 1,
        minutes: 0.5,
        confirmMinutes: 0.5,
        loginsFile: await logins("upgrade", [{ id: "cursor-upgrade", provider: "cursor", upgrade: true }]),
        replay: null,
        runnerImage: async () => fakeImage,
        print: (line) => lines.push(line),
      });

      await expect(run).rejects.toThrow(`No testing intern completed: i1 failed: ${detail}`);
      const runDir = lines[0];
      if (runDir === undefined) throw new Error("runQa printed no run directory");
      const state = await readState(runDir);
      expect(state.phase).toBe("failed");
      expect(intern(state, "i1")).toMatchObject({ login: "cursor-upgrade", status: "failed", findings: 0, detail });

      expect(await leftovers(state.runId)).toEqual([]);
      expect(await workspaces(runDir, state)).toEqual([]);
      expect(await disks(runDir, state)).toEqual([]);
    },
    timeout,
  );

  test(
    "an intern whose turn makes no tool call before its time box ends, as OpenCode does at an OpenCode Go usage limit, fails, and so does a run with no other intern",
    async () => {
      const lines: string[] = [];
      const detail = "made no tool call in its 0.5 minutes";
      const run = runQa({
        dir: target,
        rev: "HEAD",
        dirty: false,
        interns: 1,
        minutes: 0.5,
        confirmMinutes: 0.5,
        loginsFile: await logins("hang", [{ id: "grok-hang", provider: "grok", hang: true }]),
        replay: null,
        runnerImage: async () => fakeImage,
        print: (line) => lines.push(line),
      });

      await expect(run).rejects.toThrow(`No testing intern completed: i1 failed: ${detail}`);
      const runDir = lines[0];
      if (runDir === undefined) throw new Error("runQa printed no run directory");
      const state = await readState(runDir);
      expect(state.phase).toBe("failed");
      expect(intern(state, "i1")).toMatchObject({ login: "grok-hang", status: "failed", findings: 0, detail });

      expect(await leftovers(state.runId)).toEqual([]);
      expect(await workspaces(runDir, state)).toEqual([]);
      expect(await disks(runDir, state)).toEqual([]);
    },
    timeout,
  );

  test(
    "an intern whose teardown fails after a login failure names the failed login in its detail",
    async () => {
      const lines: string[] = [];
      const failure = `login claude-limit failed with -32603: Internal error: You've hit your limit: {"errorKind":"rate_limit"}`;
      let held = null as string | null;
      const run = runQa({
        dir: target,
        rev: "HEAD",
        dirty: false,
        interns: 1,
        minutes: 0.5,
        confirmMinutes: 0.5,
        loginsFile: await logins("teardown", [{ id: "claude-limit", provider: "claude", limit: true }]),
        replay: null,
        runnerImage: async () => fakeImage,
        print: (line) => {
          lines.push(line);
          const [dir] = lines;
          if (dir === undefined || line !== "i1 starting on claude-limit (claude)") return;
          held = `qair-f-e2e-held-${basename(dir)}`;
          Bun.spawnSync(["docker", "network", "create", "--internal", "--label", `com.docker.compose.project=qa-${basename(dir)}-i1`, held], { stdout: "ignore" });
          Bun.spawnSync(["docker", "run", "-d", "--rm", "--name", held, "--network", held, fakeImage], { stdout: "ignore" });
        },
      });

      try {
        await expect(run).rejects.toThrow(`No testing intern completed: i1 failed: ${failure}; teardown failed: `);
      } finally {
        if (held !== null) {
          await capture(["docker", "rm", "-f", held]);
          await capture(["docker", "network", "rm", held]);
        }
        const [dir] = lines;
        if (dir !== undefined) await stopRun(dir, basename(dir));
      }
      const runDir = lines[0];
      if (runDir === undefined) throw new Error("runQa printed no run directory");
      const state = await readState(runDir);
      expect(intern(state, "i1")).toMatchObject({ login: "claude-limit", status: "failed" });
      expect(intern(state, "i1").detail).toStartWith(`${failure}; teardown failed: docker compose down left objects of qa-${state.runId}-i1 behind`);
      expect(await leftovers(state.runId)).toEqual([]);
    },
    timeout,
  );

  test(
    "a run whose --focus names a position past the end of the focus list fails before it builds images",
    async () => {
      const lines: string[] = [];
      let runnerImage = false;
      const run = runQa({
        dir: target,
        rev: "HEAD",
        dirty: false,
        interns: 1,
        minutes: 0.5,
        confirmMinutes: 0.5,
        focus: [2, 3],
        loginsFile: await logins("focus", [{ id: "claude-1", provider: "claude" }]),
        replay: null,
        runnerImage: async () => {
          runnerImage = true;
          return fakeImage;
        },
        print: (line) => lines.push(line),
      });

      const error = "--focus 3 names no entry of the target's focus list, which has 2 entries";
      await expect(run).rejects.toThrow(error);
      const [runDir = ""] = lines;
      expect(lines).toEqual([runDir, "phase preparing"]);
      expect(runnerImage).toBe(false);
      expect(await readState(runDir)).toMatchObject({ phase: "failed", error, interns: [] });
    },
    timeout,
  );
});
