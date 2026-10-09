import { describe, expect, test } from "bun:test";
import { existsSync, rmSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { stopRun } from "../src/environment.ts";
import { runQa } from "../src/run.ts";
import { newRunId, readState } from "../src/state.ts";
import { capture, execute } from "../src/target.ts";
import type { EnvironmentStats } from "../src/types.ts";
import { disks, dockerAvailable, endToEnd, firstPrompt, intendedBehavior, intern, knownGap, leftovers, runLocks, timeout, title, workspaces } from "./e2e.ts";
import { freeBlock } from "./subnet.ts";

describe.skipIf(!dockerAvailable)("end to end with the fake agent", () => {
  const { id, root, target, fakeImage, logins } = endToEnd();

  test(
    "two interns report one defect, the judge groups it, and a confirmation reproduces it",
    async () => {
      const lines: string[] = [];
      const ended = join(root, "pair-ended.txt");
      const runDir = await runQa({
        dir: target,
        rev: "HEAD",
        dirty: false,
        interns: 2,
        minutes: 0.5,
        confirmMinutes: 0.5,
        loginsFile: await logins("pair", {}, 2),
        replay: null,
        onEnd: `test -f "$QA_INTERNS_RUN_DIR/report.md" && printf '%s\\n' "$QA_INTERNS_RUN_DIR" "$QA_INTERNS_PHASE" > '${ended}'`,
        runnerImage: async () => fakeImage,
        admit: () => () => {},
        print: (line) => lines.push(line),
      });

      expect(lines[0]).toBe(runDir);
      expect(await Bun.file(ended).text()).toBe(`${runDir}\ndone\n`);
      expect(lines).toContain("phase grouping");
      expect(lines).toContain("phase confirming");
      const state = await readState(runDir);
      expect(state).toMatchObject({ phase: "done", error: null, target: { path: "eval/ledger" }, options: { interns: 2 } });
      expect(existsSync(join(runLocks, state.runId))).toBe(false);
      expect(state.options.concurrency).toBeGreaterThanOrEqual(1);
      expect(state.options.confirmConcurrency).toBe(1);
      expect(state.interns.map((entry) => [entry.id, entry.role, entry.status, entry.findings, entry.model])).toEqual([
        ["i1", "intern", "done", 1, "openrouter/anthropic/claude-haiku-5.5"],
        ["i2", "intern", "done", 1, "openrouter/anthropic/claude-haiku-5.5"],
        ["judge", "judge", "done", 0, "openrouter/anthropic/claude-haiku-5.5"],
        ["c1", "confirm", "done", 0, "openrouter/anthropic/claude-haiku-5.5"],
      ]);
      expect(intern(state, "i1").detail).toBe('stopped at minute 0: "Nothing more to test."');
      expect([intern(state, "i1").charter, intern(state, "i2").charter]).toEqual([
        "Project focus: How invoices calculate, store, and show money across currencies, lists, and exports.",
        "Project focus: What owners, editors, and viewers can see and change, in the pages and in the API.",
      ]);
      expect(state.interns.map((entry) => entry.login)).toEqual(["openrouter-1", "openrouter-1", "openrouter-1", "openrouter-1"]);
      expect(lines).toContain("i1 starting on openrouter-1");
      const [charterPrompt, confirmationPrompt] = await Promise.all(["i1", "c1"].map((internId) => firstPrompt(runDir, internId)));
      expect(charterPrompt).toContain(`  - ${knownGap}`);
      expect(confirmationPrompt).toContain("/qa/out/confirmation.json");
      expect(confirmationPrompt).not.toContain(knownGap);
      expect(charterPrompt).toContain(`  - ${intendedBehavior}`);
      expect(confirmationPrompt).toContain(`  - ${intendedBehavior}`);

      const report = await Bun.file(join(runDir, "findings.json")).json();
      expect(report.egress).toEqual([]);
      expect(report.groups).toHaveLength(1);
      expect(report.groups[0]).toMatchObject({
        id: "g1",
        confirmed: true,
        reproductions: ["i1", "i2", "c1"],
        confirmation: {
          intern: "c1",
          result: { steps: true, task: true, observed: "fake reproduction", evidence: ["interns/c1/out/evidence/reproduction.txt"] },
          error: null,
        },
      });
      expect(report.groups[0].findings.map((finding: { id: string }) => finding.id)).toEqual(["i1/fake-home", "i2/fake-home"]);
      expect(report.groups[0].findings[0]).toMatchObject({
        title,
        evidence: ["interns/i1/out/evidence/page.html"],
        environment: { commit: state.target.commit, dirty: false, environment: `qa-${state.runId}-i1`, model: "openrouter/anthropic/claude-haiku-5.5" },
      });
      expect(await Bun.file(join(runDir, "interns", "i1", "out", "evidence", "page.html")).text()).toContain("<form");
      expect(await Bun.file(join(runDir, "interns", "i1", "out", "evidence", "browser.json")).json()).toEqual({
        isSecureContext: true,
        randomUUID: "function",
        subtle: "object",
        clipboard: "object",
      });

      const environments: EnvironmentStats[] = report.environments;
      expect(environments.map((entry) => entry.intern).sort()).toEqual(["c1", "i1", "i2", "judge"]);
      for (const entry of environments) {
        expect(Date.parse(entry.readyAt ?? "")).toBeGreaterThan(Date.parse(entry.startedAt));
        expect(entry.containers?.filter((container) => container.state !== "running" || container.oomKilled || container.restarts !== 0 || (container.memoryPeak ?? 0) <= 0)).toEqual([]);
      }
      const services = (internId: string) => environments.find((entry) => entry.intern === internId)?.containers?.map((container) => container.service);
      expect(services("i1")).toEqual(["db", "qa-proxy", "qa-runner", "web"]);
      expect(services("judge")).toEqual(["qa-proxy", "qa-runner"]);

      const markdown = await Bun.file(join(runDir, "report.md")).text();
      const confirmed = markdown.slice(markdown.indexOf("## Confirmed"), markdown.indexOf("## Not confirmed"));
      expect(confirmed).toContain(`### ${title}`);
      expect(confirmed).toContain("- Reproductions: 3 (i1, i2, c1)");
      expect(report.run.browser).toMatch(/^Google Chrome for Testing \d+\./);
      expect(markdown.split("\n")).toContain(`- Browser: ${report.run.browser}`);
      expect(confirmed).toContain(`  - Browser version: ${report.run.browser}`);
      const usage = markdown.slice(markdown.indexOf("## Environments"));
      expect(usage).toContain("### judge\n\n- Started: ");
      const web = usage.split("\n").filter((line) => line.startsWith("| web-1 | running | "));
      expect(web).toHaveLength(3);
      for (const line of web) expect(line).toEndWith(" MiB | no | 0 |");

      const draft = join(runDir, "tickets", "g1");
      expect(await readdir(join(runDir, "tickets"))).toEqual(["g1"]);
      expect(await Bun.file(join(draft, "title.txt")).text()).toBe(`${title}\n`);
      expect(await Bun.file(join(draft, "body.md")).text()).toStartWith(`- Run: ${state.runId}\n- Commit: \`${state.target.commit}\`\n- Kind: `);
      expect(await Bun.file(join(draft, "interns", "i1", "out", "evidence", "page.html")).text()).toBe(await Bun.file(join(runDir, "interns", "i1", "out", "evidence", "page.html")).text());
      expect(await Bun.file(join(draft, "interns", "c1", "out", "evidence", "reproduction.txt")).text()).toBe("fake reproduction\n");

      expect(await leftovers(state.runId)).toEqual([]);
      expect(await workspaces(runDir, state)).toEqual([]);
      expect(await disks(runDir, state)).toEqual([]);
    },
    timeout,
  );

  test(
    "the confirming phase runs one confirmation per group at once, more than the run has testing interns",
    async () => {
      const runDir = await runQa({
        dir: target,
        rev: "HEAD",
        dirty: false,
        interns: 1,
        minutes: 0.5,
        confirmMinutes: 0.5,
        loginsFile: await logins("wide", { second: true }, 2),
        replay: null,
        runnerImage: async () => fakeImage,
        admit: () => () => {},
        print: () => {},
      });

      const state = await readState(runDir);
      expect(state).toMatchObject({ phase: "done", error: null, options: { interns: 1, concurrency: 1, confirmConcurrency: 2 } });
      const confirmations = state.interns.filter((entry) => entry.role === "confirm");
      expect(confirmations.map((entry) => [entry.id, entry.status, entry.detail])).toEqual([
        ["c1", "done", "reproduced"],
        ["c2", "done", "reproduced"],
      ]);
      const starts = confirmations.map((entry) => Date.parse(entry.startedAt ?? ""));
      const ends = confirmations.map((entry) => Date.parse(entry.endedAt ?? ""));
      expect(Math.max(...starts)).toBeLessThan(Math.min(...ends));
    },
    timeout,
  );

  test(
    "the confirmation budget stops the confirmation that is running at its end and starts no later one, which the report lists as not confirmed",
    async () => {
      const runDir = await runQa({
        dir: target,
        rev: "HEAD",
        dirty: false,
        interns: 1,
        minutes: 0.5,
        confirmMinutes: 5,
        confirmBudget: 2,
        loginsFile: await logins("budget", { second: true, late: true }),
        replay: null,
        runnerImage: async () => fakeImage,
        admit: () => () => {},
        print: () => {},
      });

      const state = await readState(runDir);
      expect(state).toMatchObject({ phase: "done", error: null, options: { concurrency: 1, confirmConcurrency: 1 } });
      const [first, second] = ["c1", "c2"].map((internId) => intern(state, internId));
      expect([first?.status, first?.detail]).toEqual(["done", "reproduced"]);
      expect(Date.parse(first?.endedAt ?? "") - Date.parse(first?.startedAt ?? "")).toBeLessThan(4.5 * 60_000);
      expect([second?.status, second?.detail]).toEqual(["failed", "the confirmation budget ended before its confirmation began"]);
      expect(second?.model).toBeNull();
      expect(await firstPrompt(runDir, "c1")).toMatch(/Time box: [12] minutes\./);

      const report = await Bun.file(join(runDir, "findings.json")).json();
      expect(report.groups.map((group: { id: string; confirmed: boolean }) => [group.id, group.confirmed])).toEqual([
        ["g1", true],
        ["g2", false],
      ]);
      expect(report.groups[1].confirmation).toEqual({ intern: "c2", result: null, error: "the confirmation budget ended before its confirmation began" });
      expect(await Bun.file(join(runDir, "report.md")).text()).toContain("Confirmation: c2 failed: the confirmation budget ended before its confirmation began");
      expect(await leftovers(state.runId)).toEqual([]);
    },
    timeout,
  );

  test(
    "a confirming intern takes the login of the one before it once that intern's containers and networks are removed, before its teardown ends",
    async () => {
      const runDir = await runQa({
        dir: target,
        rev: "HEAD",
        dirty: false,
        interns: 1,
        minutes: 0.5,
        confirmMinutes: 0.5,
        loginsFile: await logins("handoff", { second: true }),
        replay: null,
        runnerImage: async () => fakeImage,
        admit: () => () => {},
        print: () => {},
      });

      const state = await readState(runDir);
      expect(state).toMatchObject({ phase: "done", error: null, options: { concurrency: 1, confirmConcurrency: 1 } });
      const confirmations = state.interns.filter((entry) => entry.role === "confirm").toSorted((a, b) => Date.parse(a.startedAt ?? "") - Date.parse(b.startedAt ?? ""));
      expect(confirmations.map((entry) => entry.status)).toEqual(["done", "done"]);
      const [first, second] = confirmations;
      expect(Date.parse(second?.startedAt ?? "")).toBeLessThan(Date.parse(first?.endedAt ?? ""));
      expect(await leftovers(state.runId)).toEqual([]);
      expect(await workspaces(runDir, state)).toEqual([]);
      expect(await disks(runDir, state)).toEqual([]);
    },
    timeout,
  );

  test(
    "a run first tears down what a run whose process ended left, without creating its deleted run directory, and leaves a run whose process lives",
    async () => {
      const module = join(import.meta.dir, "..", "src", "environment.ts");
      const hold = async (runId: string, runDir: string) => {
        const holder = Bun.spawn([process.execPath, "-e", `const { holdRun } = await import(${JSON.stringify(module)}); holdRun(${JSON.stringify(runId)}, ${JSON.stringify(runDir)}); console.log("held"); await Bun.sleep(600000);`], {
          env: { ...process.env },
          stdout: "pipe",
        });
        await holder.stdout.getReader().read();
        return holder;
      };
      const dead = newRunId();
      const live = newRunId();
      const deadDir = join(root, "swept", dead);
      const compose = join(root, `swept-${dead}.yml`);
      await Bun.write(compose, `services:\n  qa-relay:\n    image: ${JSON.stringify(fakeImage)}\n    command: ["sleep", "infinity"]\n`);
      const third = await freeBlock(214);
      const blocker = `qair-f-e2e-${id}-swept`;
      const previous = process.env.QA_INTERNS_SUBNET;
      const deadHolder = await hold(dead, deadDir);
      const liveHolder = await hold(live, join(root, "swept", live));
      try {
        await execute(["docker", "compose", "-p", `qa-${dead}-i1`, "-f", compose, "up", "-d"]);
        await execute(["docker", "tag", fakeImage, `qa-${dead}-web:latest`]);
        await execute(["docker", "tag", fakeImage, `qa-${live}-web:latest`]);
        await execute(["docker", "network", "create", "--internal", "--subnet", `10.214.${third}.0/25`, blocker]);
        deadHolder.kill("SIGKILL");
        await deadHolder.exited;
        process.env.QA_INTERNS_SUBNET = `10.214.${third}.0/23`;
        const loginsFile = await logins("swept");
        const run = runQa({ dir: target, rev: "HEAD", dirty: false, interns: 1, minutes: 0.5, confirmMinutes: 0.5, loginsFile, replay: null, runnerImage: async () => fakeImage, admit: () => () => {}, print: () => {} });
        await expect(run).rejects.toThrow("No free network slot");
        expect(await leftovers(dead)).toEqual([]);
        expect(existsSync(deadDir)).toBe(false);
        expect(existsSync(join(runLocks, dead))).toBe(false);
        expect(await leftovers(live)).toEqual([`qa-${live}-web:latest`]);
      } finally {
        if (previous === undefined) delete process.env.QA_INTERNS_SUBNET;
        else process.env.QA_INTERNS_SUBNET = previous;
        deadHolder.kill("SIGKILL");
        liveHolder.kill("SIGKILL");
        await Promise.all([deadHolder.exited, liveHolder.exited]);
        await capture(["docker", "network", "rm", blocker]);
        await stopRun(deadDir, dead);
        await stopRun(join(root, "swept", live), live);
        rmSync(join(runLocks, live), { force: true });
      }
    },
    timeout,
  );
});
