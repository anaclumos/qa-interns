import { beforeAll, describe, expect, test } from "bun:test";
import { existsSync, rmSync } from "node:fs";
import { basename, join } from "node:path";
import { stopRun } from "../src/environment.ts";
import { timeUpPrompt } from "../src/prompt.ts";
import { readReplay } from "../src/report.ts";
import { runQa } from "../src/run.ts";
import { readState } from "../src/state.ts";
import { execute } from "../src/target.ts";
import type { EnvironmentStats, RunState } from "../src/types.ts";
import { disks, dockerAvailable, endToEnd, intern, leftovers, runLocks, timeout, title, workspaces } from "./e2e.ts";

describe.skipIf(!dockerAvailable)("end to end with the fake agent", () => {
  const { root, target, fakeImage, logins, blockTeardown } = endToEnd();
  let loginsFile = "";
  let sourceDir = "";
  let source: RunState;
  let next = "";

  beforeAll(async () => {
    loginsFile = await logins("replay", [{ id: "claude-1", provider: "claude" }]);
    sourceDir = await runQa({ dir: target, rev: "HEAD", dirty: false, interns: 1, minutes: 0.5, confirmMinutes: 0.5, loginsFile, replay: null, runnerImage: async () => fakeImage, admit: () => () => {}, print: () => {} });
    source = await readState(sourceDir);
    const git = ["git", "-C", join(root, "repo"), "-c", "user.name=QA Interns", "-c", "user.email=qa@example.test", "-c", "commit.gpgsign=false"];
    next = (await execute([...git, "commit-tree", "-p", source.target.commit, "-m", "Next", `${source.target.commit}^{tree}`])).trim();
  }, timeout);

  async function clean(dir: string, run: RunState) {
    expect(await leftovers(run.runId)).toEqual([]);
    expect(await workspaces(dir, run)).toEqual([]);
    expect(await disks(dir, run)).toEqual([]);
  }

  test(
    "a replay hands the confirmed group of an earlier run to a confirming intern at a new commit and reports that it reproduced",
    async () => {
      await expect(readReplay(sourceDir, ["g1", "g2"])).rejects.toThrow(`Run ${source.runId} has no confirmed group g2. Its confirmed groups are g1.`);

      const replay = await readReplay(sourceDir, ["g1"]);
      const lines: string[] = [];
      const runDir = await runQa({
        dir: join(replay.target.repo, replay.target.path),
        rev: next,
        dirty: false,
        interns: 0,
        minutes: 0,
        confirmMinutes: 0.5,
        loginsFile,
        replay,
        runnerImage: async () => fakeImage,
        admit: () => () => {},
        print: (line) => lines.push(line),
      });

      expect(lines[0]).toBe(runDir);
      expect(lines.filter((line) => line.startsWith("phase "))).toEqual(["phase preparing", "phase building", "phase confirming", "phase reporting"]);
      const state = await readState(runDir);
      expect(state).toMatchObject({ phase: "done", error: null, target: { path: "eval/ledger", commit: next }, options: { interns: 0, minutes: 0, confirmMinutes: 0.5, concurrency: 0, confirmConcurrency: 1 } });
      expect(state.interns.map((entry) => [entry.id, entry.role, entry.group, entry.charter, entry.status, entry.detail])).toEqual([["c1", "confirm", "g1", title, "done", "reproduced"]]);
      const prompts = (await Bun.file(join(runDir, "interns", "c1", "transcript.jsonl")).text())
        .split("\n")
        .filter((line) => line !== "")
        .map((line) => JSON.parse(line))
        .filter((line) => line.from === "client" && line.message.method === "session/prompt")
        .map((line) => JSON.stringify(line.message.params));
      expect(prompts[0]).toContain("Another intern reported the finding below");
      expect(prompts[0]).toContain(title);

      const report = await Bun.file(join(runDir, "findings.json")).json();
      expect(report.run).toMatchObject({ replay: { runId: source.runId, commit: source.target.commit }, reproducedGroups: 1, notReproducedGroups: 0, uncheckedGroups: 0 });
      expect(report.groups).toHaveLength(1);
      expect(report.groups[0]).toMatchObject({
        id: "g1",
        reproduced: true,
        finding: { id: "i1/fake-home", title, environment: { commit: source.target.commit, environment: `qa-${source.runId}-i1` } },
        confirmation: { intern: "c1", provider: "claude", result: { steps: true, task: true, observed: "fake reproduction", evidence: ["interns/c1/out/evidence/reproduction.txt"] }, error: null },
      });
      expect(report.environments.map((entry: EnvironmentStats) => [entry.intern, entry.attempt, entry.readyAt === null, entry.containers?.map((container) => container.service)])).toEqual([
        ["c1", 1, false, ["db", "qa-proxy", "qa-runner", "web"]],
      ]);
      const markdown = await Bun.file(join(runDir, "report.md")).text();
      expect(markdown).toContain(`- Replay of: run \`${source.runId}\` at commit \`${source.target.commit}\`\n`);
      const reproduced = markdown.slice(markdown.indexOf("## Reproduced"), markdown.indexOf("## Not reproduced"));
      expect(reproduced).toContain(`### ${title}`);
      expect(reproduced).toContain(`- Group: g1 in run ${source.runId}`);
      await expect(readReplay(runDir, [])).rejects.toThrow(`Run ${state.runId} is a replay of run ${source.runId}. Replay run ${source.runId} instead.`);

      await clean(sourceDir, source);
      await clean(runDir, state);
    },
    timeout,
  );

  test(
    "a replay whose confirming intern writes no confirmation fails and leaves its group unchecked",
    async () => {
      const replay = await readReplay(sourceDir, []);
      const failedLines: string[] = [];
      await expect(
        runQa({
          dir: join(replay.target.repo, replay.target.path),
          rev: next,
          dirty: false,
          interns: 0,
          minutes: 0,
          confirmMinutes: 0.5,
          loginsFile: await logins("replay-silent", [{ id: "claude-no-confirm", provider: "claude", confirms: false }]),
          replay,
          runnerImage: async () => fakeImage,
          admit: () => () => {},
          print: (line) => failedLines.push(line),
        }),
      ).rejects.toThrow("No confirming intern recorded a result: c1 done: confirmation failed: no confirmation.json written");
      const failedDir = failedLines[0] ?? "";
      const failed = await readState(failedDir);
      expect(failed.phase).toBe("failed");
      const failedReport = await Bun.file(join(failedDir, "findings.json")).json();
      expect(failedReport.run).toMatchObject({ reproducedGroups: 0, notReproducedGroups: 0, uncheckedGroups: 1 });
      expect(failedReport.groups[0]).toMatchObject({ id: "g1", reproduced: null, confirmation: { intern: "c1", result: null, error: "no confirmation.json written" } });

      await clean(failedDir, failed);
    },
    timeout,
  );

  test(
    "a replay reports that it reproduced when the intern writes its confirmation only after its time box ends",
    async () => {
      const replay = await readReplay(sourceDir, ["g1"]);
      const lateDir = await runQa({
        dir: join(replay.target.repo, replay.target.path),
        rev: next,
        dirty: false,
        interns: 0,
        minutes: 0,
        confirmMinutes: 0.5,
        loginsFile: await logins("replay-late", [{ id: "claude-late", provider: "claude", late: true }]),
        replay,
        runnerImage: async () => fakeImage,
        admit: () => () => {},
        print: () => {},
      });
      const late = await readState(lateDir);
      expect(intern(late, "c1")).toMatchObject({ status: "done", detail: "reproduced" });
      const lateTraffic = (await Bun.file(join(lateDir, "interns", "c1", "transcript.jsonl")).text())
        .split("\n")
        .filter((line) => line !== "")
        .map((line) => JSON.parse(line))
        .filter((line) => line.from === "client" && (line.message.method === "session/prompt" || line.message.method === "session/cancel"));
      expect(lateTraffic.map((line) => line.message.method)).toEqual(["session/prompt", "session/cancel", "session/prompt"]);
      expect(lateTraffic[2].message.params.prompt).toEqual([{ type: "text", text: timeUpPrompt() }]);
      const lateReport = await Bun.file(join(lateDir, "findings.json")).json();
      expect(lateReport.groups[0]).toMatchObject({ id: "g1", reproduced: true, confirmation: { intern: "c1", result: { steps: true, task: true }, error: null } });

      await clean(lateDir, late);
    },
    timeout,
  );

  test(
    "a replay sends no prompt after a turn that a cancel does not end",
    async () => {
      const replay = await readReplay(sourceDir, ["g1"]);
      const deafLines: string[] = [];
      await expect(
        runQa({
          dir: join(replay.target.repo, replay.target.path),
          rev: next,
          dirty: false,
          interns: 0,
          minutes: 0,
          confirmMinutes: 0.5,
          loginsFile: await logins("replay-deaf", [{ id: "claude-deaf", provider: "claude", late: true, deaf: true }]),
          replay,
          runnerImage: async () => fakeImage,
          admit: () => () => {},
          print: (line) => deafLines.push(line),
        }),
      ).rejects.toThrow("No confirming intern recorded a result: c1 done: confirmation failed: no confirmation.json written");
      const deafDir = deafLines[0] ?? "";
      const deaf = await readState(deafDir);
      const deafTraffic = (await Bun.file(join(deafDir, "interns", "c1", "transcript.jsonl")).text())
        .split("\n")
        .filter((line) => line !== "")
        .map((line) => JSON.parse(line))
        .filter((line) => line.from === "client" && (line.message.method === "session/prompt" || line.message.method === "session/cancel"));
      expect(deafTraffic.map((line) => line.message.method)).toEqual(["session/prompt", "session/cancel"]);

      await clean(deafDir, deaf);
    },
    timeout,
  );

  test(
    "a replay rejects a confirmation whose evidence the runner swaps for a link outside /qa/out before teardown",
    async () => {
      const replay = await readReplay(sourceDir, []);
      const swappedLines: string[] = [];
      const outside = "evidence path evidence/reproduction.txt resolves outside /qa/out";
      await expect(
        runQa({
          dir: join(replay.target.repo, replay.target.path),
          rev: next,
          dirty: false,
          interns: 0,
          minutes: 0,
          confirmMinutes: 0.5,
          loginsFile: await logins("replay-swap", [{ id: "claude-swap", provider: "claude", swap: true }]),
          replay,
          runnerImage: async () => fakeImage,
          admit: () => () => {},
          print: (line) => swappedLines.push(line),
        }),
      ).rejects.toThrow(`No confirming intern recorded a result: c1 done: reproduced; confirmation failed after teardown: ${outside}`);
      const swappedDir = swappedLines[0] ?? "";
      const swapped = await readState(swappedDir);
      const swappedReport = await Bun.file(join(swappedDir, "findings.json")).json();
      expect(swappedReport.groups[0]).toMatchObject({ id: "g1", reproduced: null, confirmation: { intern: "c1", result: null, error: outside } });
      expect(await Bun.file(join(swappedDir, "report.md")).text()).not.toContain("interns/c1/out/evidence/reproduction.txt");

      await clean(swappedDir, swapped);
    },
    timeout,
  );

  test(
    "a replay does not read a confirmation from an environment that its teardown did not remove",
    async () => {
      const replay = await readReplay(sourceDir, []);
      const lines: string[] = [];
      let release = async () => {};
      const unremoved = "its environment was not removed, so its runner may still write to /qa/out and its output was not read";
      const run = runQa({
        dir: join(replay.target.repo, replay.target.path),
        rev: next,
        dirty: false,
        interns: 0,
        minutes: 0,
        confirmMinutes: 0.5,
        loginsFile: await logins("replay-unremoved", [{ id: "claude-unremoved", provider: "claude" }]),
        replay,
        runnerImage: async () => fakeImage,
        admit: () => () => {},
        print: (line) => {
          lines.push(line);
          const [dir] = lines;
          if (dir !== undefined && line === "c1 starting on claude-unremoved (claude)") release = blockTeardown(dir, "c1");
        },
      });

      try {
        await expect(run).rejects.toThrow("No confirming intern recorded a result: c1 failed: teardown failed: docker compose down left objects of");
      } finally {
        await release();
        const [dir] = lines;
        if (dir !== undefined) await stopRun(dir, basename(dir));
      }
      const runDir = lines[0] ?? "";
      const state = await readState(runDir);
      expect(intern(state, "c1").detail).toEndWith(`; ${unremoved}`);
      const report = await Bun.file(join(runDir, "findings.json")).json();
      expect(report.groups[0]).toMatchObject({ id: "g1", reproduced: null, confirmation: { intern: "c1", result: null, error: unremoved } });
      expect(await leftovers(state.runId)).toEqual([]);
      expect(existsSync(join(runLocks, state.runId))).toBe(true);
      rmSync(join(runLocks, state.runId));
    },
    timeout,
  );
});
