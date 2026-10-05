import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { runQa } from "../src/run.ts";
import { readState } from "../src/state.ts";
import { execute } from "../src/target.ts";
import type { EnvironmentStats, Finding } from "../src/types.ts";
import { disks, dockerAvailable, endToEnd, intern, internalSubnet, leftovers, timeout, workspaces } from "./e2e.ts";
import { freeBlock } from "./subnet.ts";
import { suiteLabel } from "./suite-lock.ts";

describe.skipIf(!dockerAvailable)("end to end with the fake agent", () => {
  const { id, root, target, fakeImage, logins } = endToEnd();

  test(
    "an intern at a usage limit moves to another login and restarts its charter in a free subnet, and each attempt keeps its own output",
    async () => {
      const lines: string[] = [];
      const blocker = `qair-f-e2e-${id}-slot`;
      let first = null as string | null;
      let blocked = null as number | null;
      const previous = process.env.QA_INTERNS_SUBNET;
      process.env.QA_INTERNS_SUBNET = `10.214.${await freeBlock(214)}.0/22`;
      const runDir = await runQa({
        dir: target,
        rev: "HEAD",
        dirty: false,
        interns: 1,
        minutes: 0.5,
        confirmMinutes: 0.5,
        loginsFile: await logins("limit", [
          { id: "claude-charter-limit", provider: "claude", limit: "charter", model: "fake-model-a" },
          { id: "claude-confirm-limit", provider: "claude", limit: "confirmation", model: "fake-model-b" },
          { id: "claude-no-confirm", provider: "claude", confirms: false, model: "fake-model-c" },
        ]),
        replay: null,
        runnerImage: async () => fakeImage,
        print: (line) => {
          lines.push(line);
          const [dir] = lines;
          if (dir === undefined || line !== "i1 starting on claude-confirm-limit (claude)") return;
          first = internalSubnet(dir, "i1");
          blocked = Bun.spawnSync(["docker", "network", "create", "--internal", "--label", suiteLabel, "--subnet", first, blocker], { stdout: "ignore" }).exitCode;
        },
      }).finally(async () => {
        if (previous === undefined) delete process.env.QA_INTERNS_SUBNET;
        else process.env.QA_INTERNS_SUBNET = previous;
        if (blocked === 0) await execute(["docker", "network", "rm", blocker]);
      });

      expect(blocked).toBe(0);
      expect(lines).toContain("i1 starting on claude-charter-limit (claude)");
      expect(lines).toContain("i1 starting on claude-confirm-limit (claude)");
      const queued = lines.indexOf(`i1 queued: login claude-charter-limit failed with -32603: Internal error: You've hit your limit: {"errorKind":"rate_limit"}`);
      expect(queued).toBeGreaterThan(lines.indexOf("i1 starting on claude-charter-limit (claude)"));
      expect(queued).toBeLessThan(lines.indexOf("i1 starting on claude-confirm-limit (claude)"));
      expect(internalSubnet(runDir, "i1")).not.toBe(first);
      expect(lines).toContain("c1 starting on claude-confirm-limit (claude)");
      expect(lines).toContain("c1 starting on claude-no-confirm (claude)");
      const state = await readState(runDir);
      expect(state.phase).toBe("done");
      const moved = intern(state, "i1");
      expect(moved).toMatchObject({ login: "claude-confirm-limit", model: "fake-model-b", status: "done", findings: 2 });
      expect(moved.detail).toStartWith(`login claude-charter-limit failed with -32603: Internal error: You've hit your limit: {"errorKind":"rate_limit"}; moved to claude-confirm-limit`);
      const confirmer = intern(state, "c1");
      expect(confirmer).toMatchObject({ login: "claude-no-confirm", model: "fake-model-c", status: "done" });
      expect(confirmer.detail).toStartWith(`login claude-confirm-limit failed with -32603: Internal error: You've hit your limit: {"errorKind":"rate_limit"}; moved to claude-no-confirm`);
      expect(confirmer.detail).toEndWith("; confirmation failed: no confirmation.json written");

      const transcript = (await Bun.file(join(runDir, "interns", "i1", "transcript.jsonl")).text())
        .split("\n")
        .filter((line) => line !== "")
        .map((line) => JSON.parse(line));
      const prompts = transcript.filter((line) => line.from === "client" && line.message.method === "session/prompt");
      expect(prompts.filter((line) => JSON.stringify(line.message.params).includes("Charter: "))).toHaveLength(2);
      expect(transcript.some((line) => line.from === "agent" && line.message.error?.data?.errorKind === "rate_limit")).toBe(true);

      const report = await Bun.file(join(runDir, "findings.json")).json();
      expect(report.groups).toHaveLength(1);
      expect(report.groups[0]).toMatchObject({
        confirmed: true,
        reproductions: ["i1", "c1"],
        confirmation: {
          intern: "c1",
          provider: "claude",
          result: { steps: true, task: true, observed: "fake reproduction", evidence: ["interns/c1/out/evidence/reproduction.txt"] },
          error: null,
        },
      });
      const findings: Finding[] = report.groups[0].findings;
      expect(findings.map((finding) => [finding.id, finding.evidence, finding.environment])).toEqual([
        ["i1/fake-home", ["interns/i1/out/evidence/page.html"], { commit: state.target.commit, dirty: false, environment: `qa-${state.runId}-i1`, provider: "claude", model: "fake-model-a" }],
        ["i1/out-2/fake-home", ["interns/i1/out-2/evidence/page.html"], { commit: state.target.commit, dirty: false, environment: `qa-${state.runId}-i1`, provider: "claude", model: "fake-model-b" }],
      ]);
      expect(await Bun.file(join(runDir, "interns", "c1", "out-2", "confirmation.json")).exists()).toBe(false);
      const attempts = report.environments
        .filter((entry: EnvironmentStats) => entry.intern === "i1")
        .map((entry: EnvironmentStats) => [entry.attempt, entry.readyAt === null, entry.containers?.map((container) => container.service)]);
      expect(attempts).toEqual([
        [1, false, ["db", "qa-proxy", "qa-runner", "web"]],
        [2, false, ["db", "qa-proxy", "qa-runner", "web"]],
      ]);

      expect(await leftovers(state.runId)).toEqual([]);
      expect(await workspaces(runDir, state)).toEqual([]);
      expect(await disks(runDir, state)).toEqual([]);
    },
    timeout,
  );

  test(
    "an intern whose agent stops at a plan limit moves to the next login when the quota command of its login exits 1, and that login stays exhausted for the run",
    async () => {
      const lines: string[] = [];
      const count = join(root, "quota-count");
      const quota = ["sh", "-c", `n=$(cat '${count}' 2>/dev/null || echo 0); echo $((n + 1)) > '${count}'; [ "$n" -eq 0 ]`];
      const runDir = await runQa({
        dir: target,
        rev: "HEAD",
        dirty: false,
        interns: 1,
        minutes: 0.5,
        confirmMinutes: 0.5,
        loginsFile: await logins("quota", [
          { id: "cursor-quota", provider: "cursor", quota, upgrade: true, model: "fake-model-a" },
          { id: "claude-next", provider: "claude", model: "fake-model-b" },
        ]),
        replay: null,
        runnerImage: async () => fakeImage,
        print: (line) => lines.push(line),
      });

      expect(lines).toContain("i1 starting on cursor-quota (cursor)");
      expect(lines).toContain("i1 starting on claude-next (claude)");
      const state = await readState(runDir);
      expect(state.phase).toBe("done");
      expect(intern(state, "i1")).toMatchObject({
        login: "claude-next",
        model: "fake-model-b",
        status: "done",
        findings: 1,
        detail: 'stopped at minute 0: "\n\nUpgrade your plan to continue"; the quota command of login cursor-quota reported no quota; moved to claude-next; stopped at minute 0: "Nothing more to test."',
      });
      expect(state.interns.map((entry) => [entry.id, entry.login, entry.status])).toEqual([
        ["i1", "claude-next", "done"],
        ["c1", "claude-next", "done"],
      ]);
      expect(await Bun.file(count).text()).toBe("2\n");

      const report = await Bun.file(join(runDir, "findings.json")).json();
      const findings: Finding[] = report.groups[0].findings;
      expect(findings.map((finding) => [finding.id, finding.environment.provider, finding.environment.model])).toEqual([["i1/out-2/fake-home", "claude", "fake-model-b"]]);

      expect(await leftovers(state.runId)).toEqual([]);
      expect(await workspaces(runDir, state)).toEqual([]);
      expect(await disks(runDir, state)).toEqual([]);
    },
    timeout,
  );
});
