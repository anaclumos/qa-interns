import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { cp, mkdir, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { runQa } from "../src/run.ts";
import { ensureRunnerImage } from "../src/runner.ts";
import { readState } from "../src/state.ts";
import { execute } from "../src/target.ts";
import type { Finding, Provider, RunState } from "../src/types.ts";

const dockerAvailable = Bun.spawnSync(["docker", "info"], { stdout: "ignore", stderr: "ignore" }).exitCode === 0;

const id = crypto.randomUUID().slice(0, 8);
const root = join(tmpdir(), `qair-f-e2e-${id}`);
const fakeImage = `qair-f-e2e-runner:${id}`;
const target = join(root, "repo", "eval", "ledger");
const previousStateHome = process.env.XDG_STATE_HOME;
const timeout = 20 * 60_000;
const title = "Home page shows the fake defect";
let built = false;

type FakeLogin = { id: string; provider: Provider; limit?: "charter" | "confirmation"; model?: string; confirms?: false; flood?: true };

async function logins(name: string, entries: FakeLogin[]): Promise<string> {
  const list = [];
  for (const { id: login, provider, ...credentials } of entries) {
    const store = join(root, "stores", name, login);
    await mkdir(store, { recursive: true });
    await Bun.write(join(store, provider === "claude" ? ".credentials.json" : "auth.json"), JSON.stringify(credentials));
    list.push({ id: login, provider, store });
  }
  const file = join(root, `${name}-logins.json`);
  await Bun.write(file, JSON.stringify({ logins: list }));
  return file;
}

async function leftovers(runId: string): Promise<string[]> {
  const prefixes = [`qa-${runId}-`, `vsc-qa-${runId}-`];
  const listings = await Promise.all([
    execute(["docker", "ps", "-a", "--format", "{{.Names}}"]),
    execute(["docker", "network", "ls", "--format", "{{.Name}}"]),
    execute(["docker", "volume", "ls", "--format", "{{.Name}}"]),
    execute(["docker", "images", "--format", "{{.Repository}}:{{.Tag}}"]),
  ]);
  return listings
    .join("\n")
    .split("\n")
    .filter((name) => prefixes.some((prefix) => name.startsWith(prefix)));
}

async function workspaces(runDir: string, state: RunState): Promise<string[]> {
  const names = await Promise.all(state.interns.map(async (intern) => (await readdir(join(runDir, "envs", intern.id))).filter((entry) => entry === `qa-${state.runId}-${intern.id}` || entry === "tmp")));
  return names.flat();
}

function intern(state: RunState, internId: string) {
  const found = state.interns.find((entry) => entry.id === internId);
  if (found === undefined) throw new Error(`state has no intern ${internId}`);
  return found;
}

function internalSubnet(runDir: string, internId: string): string {
  const network = readFileSync(join(runDir, "envs", internId, "compose.qa.yml"), "utf8")
    .split("\n")
    .find((entry) => entry.startsWith("  qa_internal: "));
  if (network === undefined) throw new Error(`compose.qa.yml of ${internId} has no qa_internal network`);
  return JSON.parse(network.slice("  qa_internal: ".length)).ipam.config[0].subnet;
}

describe.skipIf(!dockerAvailable)("runQa end to end with the fake agent", () => {
  beforeAll(async () => {
    await mkdir(root);
    await cp(join(import.meta.dir, "..", "eval", "ledger"), target, { recursive: true, filter: (source) => basename(source) !== "node_modules" });
    const git = ["git", "-C", join(root, "repo"), "-c", "user.name=QA Interns", "-c", "user.email=qa@example.test", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null"];
    await execute([...git, "init", "-q"]);
    await execute([...git, "add", "-A"]);
    await execute([...git, "commit", "-q", "-m", "Ledger"]);

    const base = await ensureRunnerImage();
    const context = join(root, "image");
    await mkdir(context);
    await cp(join(import.meta.dir, "fake-agent.mjs"), join(context, "fake-agent.mjs"));
    await Bun.write(
      join(context, "Dockerfile"),
      `FROM ${base}
USER root
COPY fake-agent.mjs /opt/qa-fake/fake-agent.mjs
RUN rm /usr/local/bin/claude-agent-acp /usr/local/bin/cursor-agent /usr/local/bin/grok \\
 && printf '#!/bin/sh\\nexec env FAKE_CREDENTIAL="$CLAUDE_CONFIG_DIR/.credentials.json" node /opt/qa-fake/fake-agent.mjs "$@"\\n' > /usr/local/bin/claude-agent-acp \\
 && printf '#!/bin/sh\\nexec env FAKE_CREDENTIAL="$XDG_CONFIG_HOME/cursor/auth.json" node /opt/qa-fake/fake-agent.mjs "$@"\\n' > /usr/local/bin/cursor-agent \\
 && printf '#!/bin/sh\\nexec env FAKE_CREDENTIAL="$GROK_AUTH_PATH" node /opt/qa-fake/fake-agent.mjs "$@"\\n' > /usr/local/bin/grok \\
 && chmod 755 /usr/local/bin/claude-agent-acp /usr/local/bin/cursor-agent /usr/local/bin/grok
USER qa
`,
    );
    await execute(["docker", "build", "-q", "-t", fakeImage, context]);
    built = true;
    process.env.XDG_STATE_HOME = join(root, "state");
  }, timeout);

  afterAll(async () => {
    if (previousStateHome === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = previousStateHome;
    try {
      if (built) await execute(["docker", "image", "rm", "-f", fakeImage]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, timeout);

  test(
    "two interns on Grok and Cursor logins report one defect, the judge groups it, and a confirmation reproduces it",
    async () => {
      const lines: string[] = [];
      const runDir = await runQa({
        dir: target,
        rev: "HEAD",
        interns: 2,
        minutes: 0.5,
        confirmMinutes: 0.5,
        loginsFile: await logins("pair", [
          { id: "grok-1", provider: "grok" },
          { id: "cursor-1", provider: "cursor" },
        ]),
        runnerImage: async () => fakeImage,
        print: (line) => lines.push(line),
      });

      expect(lines[0]).toBe(runDir);
      expect(lines).toContain("phase grouping");
      expect(lines).toContain("phase confirming");
      const state = await readState(runDir);
      expect(state).toMatchObject({ phase: "done", error: null, target: { path: "eval/ledger" }, options: { interns: 2 } });
      expect(state.options.concurrency).toBeGreaterThanOrEqual(1);
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

      const report = await Bun.file(join(runDir, "findings.json")).json();
      expect(report.groups).toHaveLength(1);
      expect(report.groups[0]).toMatchObject({
        id: "g1",
        confirmed: true,
        reproductions: ["i1", "i2", "c1"],
        confirmation: {
          intern: "c1",
          provider: "cursor",
          result: { reproduced: true, observed: "fake reproduction", evidence: ["interns/c1/out/evidence/reproduction.txt"] },
          error: null,
        },
      });
      expect(report.groups[0].findings.map((finding: { id: string }) => finding.id)).toEqual(["i1/fake-home", "i2/fake-home"]);
      expect(report.groups[0].findings[0]).toMatchObject({
        title,
        evidence: ["interns/i1/out/evidence/page.html"],
        environment: { commit: state.target.commit, environment: `qa-${state.runId}-i1`, provider: intern(state, "i1").provider, model: "fake-model-1" },
      });
      expect(await Bun.file(join(runDir, "interns", "i1", "out", "evidence", "page.html")).text()).toContain("<form");

      const markdown = await Bun.file(join(runDir, "report.md")).text();
      const confirmed = markdown.slice(markdown.indexOf("## Confirmed"), markdown.indexOf("## Seen once"));
      expect(confirmed).toContain(`### ${title}`);
      expect(confirmed).toContain("- Reproductions: 3 (i1, i2, c1)");

      expect(await leftovers(state.runId)).toEqual([]);
      expect(await workspaces(runDir, state)).toEqual([]);
    },
    timeout,
  );

  test(
    "an intern at a usage limit moves to another login and restarts its charter in a free subnet, and each attempt keeps its own output",
    async () => {
      const lines: string[] = [];
      const blocker = `qair-f-e2e-${id}-slot`;
      let first = null as string | null;
      let blocked = null as number | null;
      const runDir = await runQa({
        dir: target,
        rev: "HEAD",
        interns: 1,
        minutes: 0.5,
        confirmMinutes: 0.5,
        loginsFile: await logins("limit", [
          { id: "claude-charter-limit", provider: "claude", limit: "charter", model: "fake-model-a" },
          { id: "claude-confirm-limit", provider: "claude", limit: "confirmation", model: "fake-model-b" },
          { id: "claude-no-confirm", provider: "claude", confirms: false, model: "fake-model-c" },
        ]),
        runnerImage: async () => fakeImage,
        print: (line) => {
          lines.push(line);
          const [dir] = lines;
          if (dir === undefined || line !== "i1 starting on claude-confirm-limit (claude)") return;
          first = internalSubnet(dir, "i1");
          blocked = Bun.spawnSync(["docker", "network", "create", "--internal", "--subnet", first, blocker], { stdout: "ignore" }).exitCode;
        },
      }).finally(async () => {
        if (blocked === 0) await execute(["docker", "network", "rm", blocker]);
      });

      expect(lines).toContain("i1 starting on claude-charter-limit (claude)");
      expect(lines).toContain("i1 starting on claude-confirm-limit (claude)");
      expect(internalSubnet(runDir, "i1")).not.toBe(first);
      expect(lines).toContain("c1 starting on claude-confirm-limit (claude)");
      expect(lines).toContain("c1 starting on claude-no-confirm (claude)");
      const state = await readState(runDir);
      expect(state.phase).toBe("done");
      const moved = intern(state, "i1");
      expect(moved).toMatchObject({ login: "claude-confirm-limit", model: "fake-model-b", status: "done", findings: 2 });
      expect(moved.detail).toStartWith("moved from claude-charter-limit to claude-confirm-limit after a login failure (-32603: ");
      const confirmer = intern(state, "c1");
      expect(confirmer).toMatchObject({ login: "claude-no-confirm", model: "fake-model-c", status: "done" });
      expect(confirmer.detail).toStartWith("moved from claude-confirm-limit to claude-no-confirm after a login failure (-32603: ");
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
          result: { reproduced: true, observed: "fake reproduction", evidence: ["interns/c1/out/evidence/reproduction.txt"] },
          error: null,
        },
      });
      const findings: Finding[] = report.groups[0].findings;
      expect(findings.map((finding) => [finding.id, finding.evidence, finding.environment])).toEqual([
        ["i1/fake-home", ["interns/i1/out/evidence/page.html"], { commit: state.target.commit, environment: `qa-${state.runId}-i1`, provider: "claude", model: "fake-model-a" }],
        ["i1/out-2/fake-home", ["interns/i1/out-2/evidence/page.html"], { commit: state.target.commit, environment: `qa-${state.runId}-i1`, provider: "claude", model: "fake-model-b" }],
      ]);
      expect(await Bun.file(join(runDir, "interns", "c1", "out-2", "confirmation.json")).exists()).toBe(false);

      expect(await leftovers(state.runId)).toEqual([]);
      expect(await workspaces(runDir, state)).toEqual([]);
    },
    timeout,
  );

  test(
    "a runner file stops at 1 GiB, and an intern whose /qa/out passes 1 GiB is stopped and keeps its findings",
    async () => {
      const lines: string[] = [];
      const run = runQa({
        dir: target,
        rev: "HEAD",
        interns: 1,
        minutes: 0.5,
        confirmMinutes: 0.5,
        loginsFile: await logins("flood", [{ id: "claude-flood", provider: "claude", flood: true }]),
        runnerImage: async () => fakeImage,
        print: (line) => lines.push(line),
      });

      await expect(run).rejects.toThrow("No testing intern completed");
      const runDir = lines[0];
      if (runDir === undefined) throw new Error("runQa printed no run directory");
      const state = await readState(runDir);
      expect(state.phase).toBe("failed");
      expect(intern(state, "i1")).toMatchObject({
        status: "failed",
        findings: 1,
        detail: `${join(runDir, "interns", "i1", "out")} holds more than 1 GiB, so its runner was stopped`,
      });
      expect(Bun.file(join(runDir, "interns", "i1", "out", "evidence", "big.bin")).size).toBe(1024 ** 3);

      const report = await Bun.file(join(runDir, "findings.json")).json();
      expect(report.groups.map((group: { findings: { id: string }[] }) => group.findings.map((finding) => finding.id))).toEqual([["i1/fake-home"]]);

      expect(await leftovers(state.runId)).toEqual([]);
      expect(await workspaces(runDir, state)).toEqual([]);
    },
    timeout,
  );
});
