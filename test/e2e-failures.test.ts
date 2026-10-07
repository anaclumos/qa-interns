import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { basename, join } from "node:path";
import { stopRun } from "../src/environment.ts";
import { runQa } from "../src/run.ts";
import { readState } from "../src/state.ts";
import { capture, execute } from "../src/target.ts";
import { disks, dockerAvailable, endToEnd, intern, leftovers, runLocks, timeout, workspaces } from "./e2e.ts";
import { freeBlock } from "./subnet.ts";
import { suiteLabel } from "./suite-lock.ts";

describe.skipIf(!dockerAvailable)("end to end with the fake agent", () => {
  const { id, target, fakeImage, logins } = endToEnd();

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
    "a run whose report files cannot be written records that failure in state.json",
    async () => {
      const third = await freeBlock(216);
      const subnet = `10.216.${third}.0/22`;
      const blockers: string[] = [];
      const previous = process.env.QA_INTERNS_SUBNET;
      process.env.QA_INTERNS_SUBNET = subnet;
      try {
        for (const range of [`10.216.${third}.0/25`, `10.216.${third + 3}.128/25`]) {
          const name = `qair-f-e2e-${id}-range-${blockers.length}`;
          await execute(["docker", "network", "create", "--internal", "--label", suiteLabel, "--subnet", range, name]);
          blockers.push(name);
        }
        const loginsFile = await logins("report", [{ id: "claude-1", provider: "claude" }]);
        let runDir: string | undefined;
        await expect(
          runQa({
            dir: target,
            rev: "HEAD",
            dirty: false,
            interns: 1,
            minutes: 0.5,
            confirmMinutes: 0.5,
            loginsFile,
            replay: null,
            runnerImage: async () => fakeImage,
            admit: () => () => {},
            print: (line) => {
              if (runDir === undefined) {
                runDir = line;
                mkdirSync(join(line, "report.md"), { recursive: true });
                mkdirSync(join(line, "findings.json"), { recursive: true });
              }
            },
          }),
        ).rejects.toThrow("writing the report failed");
        const state = await readState(runDir ?? "");
        expect(state.phase).toBe("failed");
        expect(state.error).toContain("writing the report failed");
        expect(state.error).toContain("No free network slot");
        expect(state.endedAt).not.toBeNull();
      } finally {
        if (previous === undefined) delete process.env.QA_INTERNS_SUBNET;
        else process.env.QA_INTERNS_SUBNET = previous;
        if (blockers.length > 0) await execute(["docker", "network", "rm", ...blockers]);
      }
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
