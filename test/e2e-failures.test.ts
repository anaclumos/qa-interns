import { describe, expect, test } from "bun:test";
import { existsSync, rmSync } from "node:fs";
import { basename, join } from "node:path";
import { stopRun } from "../src/environment.ts";
import { runQa } from "../src/run.ts";
import { readState } from "../src/state.ts";
import { capture } from "../src/target.ts";
import { disks, dockerAvailable, endToEnd, intern, leftovers, runLocks, timeout, workspaces } from "./e2e.ts";
import { suiteLabel } from "./suite-lock.ts";

describe.skipIf(!dockerAvailable)("end to end with the fake agent", () => {
  const { target, fakeImage, logins, blockTeardown } = endToEnd();

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
        admit: () => () => {},
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
        admit: () => () => {},
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
        admit: () => () => {},
        print: (line) => {
          lines.push(line);
          const [dir] = lines;
          if (dir === undefined || line !== "i1 starting on claude-limit (claude)") return;
          held = `qair-f-e2e-held-${basename(dir)}`;
          Bun.spawnSync(["docker", "network", "create", "--internal", "--label", `com.docker.compose.project=qa-${basename(dir)}-i1`, "--label", suiteLabel, held], { stdout: "ignore" });
          Bun.spawnSync(["docker", "run", "-d", "--rm", "--label", suiteLabel, "--name", held, "--network", held, fakeImage], { stdout: "ignore" });
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
      expect(existsSync(join(runLocks, state.runId))).toBe(true);
      rmSync(join(runLocks, state.runId));
    },
    timeout,
  );

  test(
    "an intern whose environment is not removed at its teardown fails and the report holds none of its findings",
    async () => {
      const lines: string[] = [];
      let release = async () => {};
      const run = runQa({
        dir: target,
        rev: "HEAD",
        dirty: false,
        interns: 1,
        minutes: 0.5,
        confirmMinutes: 0.5,
        loginsFile: await logins("unremoved", [{ id: "claude-unremoved", provider: "claude" }]),
        replay: null,
        runnerImage: async () => fakeImage,
        admit: () => () => {},
        print: (line) => {
          lines.push(line);
          const [dir] = lines;
          if (dir !== undefined && line === "i1 starting on claude-unremoved (claude)") release = blockTeardown(dir, "i1");
        },
      });

      try {
        await expect(run).rejects.toThrow("No testing intern completed: i1 failed: stopped at minute 0: \"Nothing more to test.\"; teardown failed: docker compose down left objects of");
      } finally {
        await release();
        const [dir] = lines;
        if (dir !== undefined) await stopRun(dir, basename(dir));
      }
      const runDir = lines[0];
      if (runDir === undefined) throw new Error("runQa printed no run directory");
      const state = await readState(runDir);
      expect(intern(state, "i1")).toMatchObject({ login: "claude-unremoved", status: "failed", findings: 0 });
      expect(intern(state, "i1").detail).toEndWith("; its environment was not removed, so its runner may still write to /qa/out and its output was not read");
      const report = await Bun.file(join(runDir, "findings.json")).json();
      expect(report.groups).toEqual([]);
      expect(await leftovers(state.runId)).toEqual([]);
      expect(existsSync(join(runLocks, state.runId))).toBe(true);
      rmSync(join(runLocks, state.runId));
    },
    timeout,
  );

  test(
    "a run whose output disk is busy at an intern's teardown is done when the run's teardown saves the disk",
    async () => {
      const lines: string[] = [];
      let holder: ReturnType<typeof Bun.spawn> | undefined;
      try {
        const runDir = await runQa({
          dir: target,
          rev: "HEAD",
          dirty: false,
          interns: 1,
          minutes: 0.5,
          confirmMinutes: 0.5,
          loginsFile: await logins("busy", [{ id: "grok-busy", provider: "grok" }]),
          replay: null,
          runnerImage: async () => fakeImage,
          admit: () => () => {},
          print: (line) => {
            lines.push(line);
            const [dir] = lines;
            if (dir === undefined) return;
            if (line === "i1 testing on grok-busy (grok)") holder = Bun.spawn(["sleep", "infinity"], { cwd: join(dir, "interns", "i1", "out") });
            if (line.startsWith("i1 done")) holder?.kill();
          },
        });

        const state = await readState(runDir);
        expect(state).toMatchObject({ phase: "done", error: null });
        expect(intern(state, "i1").detail).toContain(`; teardown failed: docker run --rm --name qa-${state.runId}-i1-disk-`);
        expect(intern(state, "i1").detail).toEndWith(`umount: ${join(runDir, "interns", "i1", "out")}: target is busy.`);
        expect(intern(state, "i1").findings).toBe(1);
        const report = await Bun.file(join(runDir, "findings.json")).json();
        expect(report.groups).toHaveLength(1);
        expect(report.groups[0]).toMatchObject({ confirmed: true, reproductions: ["i1", "c1"] });
        expect(await leftovers(state.runId)).toEqual([]);
        expect(await workspaces(runDir, state)).toEqual([]);
        expect(await disks(runDir, state)).toEqual([]);
      } finally {
        holder?.kill();
        await holder?.exited;
      }
    },
    timeout,
  );
});
