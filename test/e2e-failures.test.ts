import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { basename, join } from "node:path";
import { stopRun } from "../src/environment.ts";
import { runQa } from "../src/run.ts";
import { readState } from "../src/state.ts";
import { capture, execute } from "../src/target.ts";
import type { EnvironmentStats } from "../src/types.ts";
import { disks, dockerAvailable, endToEnd, intern, leftovers, runLocks, timeout, workspaces } from "./e2e.ts";
import { freeBlock } from "./subnet.ts";
import { suiteLabel } from "./suite-lock.ts";

describe.skipIf(!dockerAvailable)("end to end with the fake agent", () => {
  const { id, target, fakeImage, logins, blockTeardown } = endToEnd();

  test(
    "an intern whose agent fails a turn with a provider error ends as failed with that error and keeps the finding it wrote, and so does a run with no other intern",
    async () => {
      const lines: string[] = [];
      const failure = '-32603: Internal error: {"errorKind":"billing_error","message":"provider billing or quota wall"}';
      const run = runQa({
        dir: target,
        rev: "HEAD",
        dirty: false,
        interns: 1,
        minutes: 0.5,
        confirmMinutes: 0.5,
        loginsFile: await logins("limit", { limit: "charter" }),
        replay: null,
        runnerImage: async () => fakeImage,
        admit: () => () => {},
        print: (line) => lines.push(line),
      });

      await expect(run).rejects.toThrow(`No testing intern completed: i1 failed: ${failure}`);
      const runDir = lines[0];
      if (runDir === undefined) throw new Error("runQa printed no run directory");
      expect(lines.filter((line) => line === "i1 starting on openrouter-1")).toHaveLength(1);
      const state = await readState(runDir);
      expect(state.phase).toBe("failed");
      expect(intern(state, "i1")).toMatchObject({ login: "openrouter-1", status: "failed", findings: 1, detail: failure });
      const report = await Bun.file(join(runDir, "findings.json")).json();
      expect(report.groups.map((group: { findings: { id: string }[] }) => group.findings.map((finding) => finding.id))).toEqual([["i1/fake-home"]]);
      expect(report.environments.map((entry: EnvironmentStats) => entry.intern)).toEqual(["i1"]);

      expect(await leftovers(state.runId)).toEqual([]);
      expect(await workspaces(runDir, state)).toEqual([]);
      expect(await disks(runDir, state)).toEqual([]);
    },
    timeout,
  );

  test(
    "an intern whose agent stops before its first tool call fails, and so does a run with no other intern",
    async () => {
      const lines: string[] = [];
      const detail = 'stopped at minute 0 without a tool call: "I have nothing to test."';
      const run = runQa({
        dir: target,
        rev: "HEAD",
        dirty: false,
        interns: 1,
        minutes: 0.5,
        confirmMinutes: 0.5,
        loginsFile: await logins("idle", { idle: true }),
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
      expect(intern(state, "i1")).toMatchObject({ login: "openrouter-1", status: "failed", findings: 0, detail });

      expect(await leftovers(state.runId)).toEqual([]);
      expect(await workspaces(runDir, state)).toEqual([]);
      expect(await disks(runDir, state)).toEqual([]);
    },
    timeout,
  );

  test(
    "an intern whose turn makes no tool call before its time box ends fails, and so does a run with no other intern",
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
        loginsFile: await logins("hang", { hang: true }),
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
      expect(intern(state, "i1")).toMatchObject({ login: "openrouter-1", status: "failed", findings: 0, detail });

      expect(await leftovers(state.runId)).toEqual([]);
      expect(await workspaces(runDir, state)).toEqual([]);
      expect(await disks(runDir, state)).toEqual([]);
    },
    timeout,
  );

  test(
    "an intern whose teardown fails after a provider error names both in its detail",
    async () => {
      const lines: string[] = [];
      const failure = '-32603: Internal error: {"errorKind":"billing_error","message":"provider billing or quota wall"}';
      let held = null as string | null;
      const run = runQa({
        dir: target,
        rev: "HEAD",
        dirty: false,
        interns: 1,
        minutes: 0.5,
        confirmMinutes: 0.5,
        loginsFile: await logins("teardown", { limit: true }),
        replay: null,
        runnerImage: async () => fakeImage,
        admit: () => () => {},
        print: (line) => {
          lines.push(line);
          const [dir] = lines;
          if (dir === undefined || line !== "i1 starting on openrouter-1") return;
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
      expect(intern(state, "i1")).toMatchObject({ login: "openrouter-1", status: "failed" });
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
        const loginsFile = await logins("report");
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
        loginsFile: await logins("unremoved"),
        replay: null,
        runnerImage: async () => fakeImage,
        admit: () => () => {},
        print: (line) => {
          lines.push(line);
          const [dir] = lines;
          if (dir !== undefined && line === "i1 starting on openrouter-1") release = blockTeardown(dir, "i1");
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
      expect(intern(state, "i1")).toMatchObject({ login: "openrouter-1", status: "failed", findings: 0 });
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
        loginsFile: await logins("focus"),
        replay: null,
        runnerImage: async () => {
          runnerImage = true;
          return fakeImage;
        },
        admit: () => () => {},
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
          loginsFile: await logins("busy"),
          replay: null,
          runnerImage: async () => fakeImage,
          admit: () => () => {},
          print: (line) => {
            lines.push(line);
            const [dir] = lines;
            if (dir === undefined) return;
            if (line === "i1 testing on openrouter-1") holder = Bun.spawn(["sleep", "infinity"], { cwd: join(dir, "interns", "i1", "out") });
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
