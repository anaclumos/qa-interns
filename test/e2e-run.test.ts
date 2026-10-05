import { describe, expect, test } from "bun:test";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { runQa } from "../src/run.ts";
import { readState } from "../src/state.ts";
import type { EnvironmentStats } from "../src/types.ts";
import { disks, dockerAvailable, endToEnd, firstPrompt, intendedBehavior, intern, knownGap, leftovers, timeout, title, workspaces } from "./e2e.ts";

describe.skipIf(!dockerAvailable)("end to end with the fake agent", () => {
  const { root, target, fakeImage, logins } = endToEnd();

  test(
    "two interns on Grok and Cursor logins report one defect, the judge groups it, and a confirmation reproduces it",
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
        loginsFile: await logins("pair", [
          { id: "grok-1", provider: "grok" },
          { id: "cursor-1", provider: "cursor" },
        ]),
        replay: null,
        onEnd: `test -f "$QA_INTERNS_RUN_DIR/report.md" && printf '%s\\n' "$QA_INTERNS_RUN_DIR" "$QA_INTERNS_PHASE" > '${ended}'`,
        runnerImage: async () => fakeImage,
        print: (line) => lines.push(line),
      });

      expect(lines[0]).toBe(runDir);
      expect(await Bun.file(ended).text()).toBe(`${runDir}\ndone\n`);
      expect(lines).toContain("phase grouping");
      expect(lines).toContain("phase confirming");
      const state = await readState(runDir);
      expect(state).toMatchObject({ phase: "done", error: null, target: { path: "eval/ledger" }, options: { interns: 2 } });
      expect(state.options.concurrency).toBeGreaterThanOrEqual(1);
      expect(state.options.confirmConcurrency).toBe(1);
      expect(state.interns.map((entry) => [entry.id, entry.role, entry.status, entry.findings, entry.model])).toEqual([
        ["i1", "intern", "done", 1, "fake-model-1"],
        ["i2", "intern", "done", 1, "fake-model-1"],
        ["judge", "judge", "done", 0, "fake-model-1"],
        ["c1", "confirm", "done", 0, "fake-model-1"],
      ]);
      expect(intern(state, "i1").detail).toBe('stopped at minute 0: "Nothing more to test."');
      expect([intern(state, "i1").charter, intern(state, "i2").charter]).toEqual([
        "Project focus: How invoices calculate, store, and show money across currencies, lists, and exports.",
        "Project focus: What owners, editors, and viewers can see and change, in the pages and in the API.",
      ]);
      expect(["i1", "i2"].map((internId) => intern(state, internId).provider).sort()).toEqual(["cursor", "grok"]);
      expect(intern(state, "judge").provider).toBe("grok");
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
          provider: "grok",
          result: { steps: true, task: true, observed: "fake reproduction", evidence: ["interns/c1/out/evidence/reproduction.txt"] },
          error: null,
        },
      });
      expect(report.groups[0].findings.map((finding: { id: string }) => finding.id)).toEqual(["i1/fake-home", "i2/fake-home"]);
      expect(report.groups[0].findings[0]).toMatchObject({
        title,
        evidence: ["interns/i1/out/evidence/page.html"],
        environment: { commit: state.target.commit, dirty: false, environment: `qa-${state.runId}-i1`, provider: intern(state, "i1").provider, model: "fake-model-1" },
      });
      expect(await Bun.file(join(runDir, "interns", "i1", "out", "evidence", "page.html")).text()).toContain("<form");
      expect(await Bun.file(join(runDir, "interns", "i1", "out", "evidence", "browser.json")).json()).toEqual({
        isSecureContext: true,
        randomUUID: "function",
        subtle: "object",
        clipboard: "object",
      });

      const environments: EnvironmentStats[] = report.environments;
      expect(environments.map((entry) => `${entry.intern}/${entry.attempt}`).sort()).toEqual(["c1/1", "i1/1", "i2/1", "judge/1"]);
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
      const usage = markdown.slice(markdown.indexOf("## Environments"));
      expect(usage).toContain("### judge, attempt 1\n\n- Started: ");
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
        loginsFile: await logins("wide", [
          { id: "claude-wide-1", provider: "claude", second: true },
          { id: "claude-wide-2", provider: "claude", second: true },
        ]),
        replay: null,
        runnerImage: async () => fakeImage,
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
    "a confirming intern takes the login of the one before it once that intern's containers and networks are removed, before its teardown ends",
    async () => {
      const runDir = await runQa({
        dir: target,
        rev: "HEAD",
        dirty: false,
        interns: 1,
        minutes: 0.5,
        confirmMinutes: 0.5,
        loginsFile: await logins("handoff", [{ id: "claude-handoff", provider: "claude", second: true }]),
        replay: null,
        runnerImage: async () => fakeImage,
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
});
