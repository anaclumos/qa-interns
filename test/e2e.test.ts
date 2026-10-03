import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { cp, mkdir, readdir, realpath, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { readRelayLogs, removeCopies, removeDir, stopRun, writeChromePolicy } from "../src/environment.ts";
import { errorCode } from "../src/findings.ts";
import { readReplay } from "../src/report.ts";
import { ask, runQa, type AskOptions } from "../src/run.ts";
import { ensureRunnerImage } from "../src/runner.ts";
import { redact } from "../src/secrets.ts";
import { newRunId, readState } from "../src/state.ts";
import { capture, execute } from "../src/target.ts";
import type { EnvironmentStats, Finding, Provider, RunState } from "../src/types.ts";
import { freeBlock } from "./subnet.ts";

const dockerAvailable = Bun.spawnSync(["docker", "info"], { stdout: "ignore", stderr: "ignore" }).exitCode === 0;

const id = crypto.randomUUID().slice(0, 8);
const root = join(tmpdir(), `qair-f-e2e-${id}`);
const fakeImage = `qair-f-e2e-runner:${id}`;
const target = join(root, "repo", "eval", "ledger");
const previousStateHome = process.env.XDG_STATE_HOME;
const timeout = 20 * 60_000;
const cliScript = join(import.meta.dir, "..", "src", "cli.ts");
const title = "Home page shows the fake defect";
const knownGap = "The environment has no video model.";
let built = false;

type FakeLogin = { id: string; provider: Provider; quota?: string[]; limit?: true | "charter" | "confirmation"; model?: string; confirms?: false; flood?: true; upgrade?: true; hang?: true; stray?: true; second?: true; openrouter?: { type: "api"; key: string } };

async function logins(name: string, entries: FakeLogin[]): Promise<string> {
  const list = [];
  for (const { id: login, provider, quota, ...credentials } of entries) {
    const store = join(root, "stores", name, login);
    await mkdir(store, { recursive: true });
    await Bun.write(join(store, provider === "claude" ? ".credentials.json" : "auth.json"), JSON.stringify(credentials));
    list.push({ id: login, provider, store, quota });
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

async function disks(runDir: string, state: RunState): Promise<string[]> {
  const images = await Promise.all(state.interns.map(async (intern) => (await readdir(join(runDir, "interns", intern.id))).filter((entry) => entry.endsWith(".img") || entry.endsWith(".img.new"))));
  const mounts = readFileSync("/proc/self/mountinfo", "utf8").split("\n").filter((line) => line.includes(runDir));
  return [...images.flat(), ...mounts];
}

function intern(state: RunState, internId: string) {
  const found = state.interns.find((entry) => entry.id === internId);
  if (found === undefined) throw new Error(`state has no intern ${internId}`);
  return found;
}

async function askOptions(runId: string, name: string): Promise<AskOptions> {
  const runDir = join(root, "asks", runId);
  await mkdir(runDir, { recursive: true });
  await writeChromePolicy(runDir, {});
  return {
    runDir,
    runId,
    name,
    loginsFile: await logins(`ask-${runId}`, [{ id: "claude-1", provider: "claude" }]),
    runnerImage: fakeImage,
    prompt: "Write /qa/out/groups.json.",
    file: "groups.json",
    parse: (raw) => JSON.parse(raw),
  };
}

async function firstPrompt(runDir: string, internId: string): Promise<string> {
  const lines = (await Bun.file(join(runDir, "interns", internId, "transcript.jsonl")).text()).split("\n").filter((line) => line !== "");
  const prompt = lines.map((line) => JSON.parse(line)).find((line) => line.from === "client" && line.message.method === "session/prompt");
  if (prompt === undefined) throw new Error(`transcript of ${internId} has no session/prompt`);
  return prompt.message.params.prompt.map((block: { text: string }) => block.text).join("\n");
}

function internalSubnet(runDir: string, internId: string): string {
  const network = readFileSync(join(runDir, "envs", internId, "compose.qa.yml"), "utf8")
    .split("\n")
    .find((entry) => entry.startsWith("  qa_internal: !override "));
  if (network === undefined) throw new Error(`compose.qa.yml of ${internId} has no qa_internal network`);
  return JSON.parse(network.slice("  qa_internal: !override ".length)).ipam.config[0].subnet;
}

describe.skipIf(!dockerAvailable)("end to end with the fake agent", () => {
  beforeAll(async () => {
    await mkdir(root);
    await cp(join(import.meta.dir, "..", "eval", "ledger"), target, { recursive: true, filter: (source) => basename(source) !== "node_modules" });
    const feature = join(target, ".devcontainer", "probe-feature");
    await mkdir(feature);
    await Bun.write(join(feature, "devcontainer-feature.json"), JSON.stringify({ id: "probe-feature", version: "1.0.0", name: "Probe feature" }));
    await Bun.write(join(feature, "install.sh"), "#!/bin/sh\nset -e\n");
    const devcontainerFile = join(target, ".devcontainer", "devcontainer.json");
    const ledger = await Bun.file(devcontainerFile).json();
    const customizations = { "qa-interns": { ...ledger.customizations["qa-interns"], knownGaps: [knownGap] } };
    await Bun.write(devcontainerFile, JSON.stringify({ ...ledger, customizations, features: { "./probe-feature": {} } }));
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
RUN rm /usr/local/bin/claude-agent-acp /usr/local/bin/cursor-agent /usr/local/bin/grok /usr/local/bin/opencode \\
 && printf '#!/bin/sh\\nexec env FAKE_CREDENTIAL="$CLAUDE_SECURESTORAGE_CONFIG_DIR/.credentials.json" node /opt/qa-fake/fake-agent.mjs "$@"\\n' > /usr/local/bin/claude-agent-acp \\
 && printf '#!/bin/sh\\nexec env FAKE_CREDENTIAL="$XDG_CONFIG_HOME/cursor/auth.json" node /opt/qa-fake/fake-agent.mjs "$@"\\n' > /usr/local/bin/cursor-agent \\
 && printf '#!/bin/sh\\nexec env FAKE_CREDENTIAL="$GROK_AUTH_PATH" node /opt/qa-fake/fake-agent.mjs "$@"\\n' > /usr/local/bin/grok \\
 && printf '#!/bin/sh\\nexec env FAKE_CREDENTIAL="$XDG_DATA_HOME/opencode/auth.json" node /opt/qa-fake/fake-agent.mjs "$@"\\n' > /usr/local/bin/opencode \\
 && chmod 755 /usr/local/bin/claude-agent-acp /usr/local/bin/cursor-agent /usr/local/bin/grok /usr/local/bin/opencode
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
      await removeDir(root, fakeImage, `qair-f-e2e-${id}`);
    } finally {
      if (built) await execute(["docker", "image", "rm", "-f", fakeImage]);
    }
  }, timeout);

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
    "the report counts the connections that target services open through the relay, per egress host and outcome, with the ones a connection limit refused",
    async () => {
      const relayed = join(root, "relayed");
      await cp(target, relayed, { recursive: true });
      const file = join(relayed, ".devcontainer", "devcontainer.json");
      const config = await Bun.file(file).json();
      const settings = config.customizations["qa-interns"];
      const calls = "for (const url of ['https://api.example.test/', 'http://api.example.test:443/', 'https://api.example.test/']) await fetch(url).catch(() => {});";
      const qa = {
        ...settings,
        egress: ["api.example.test", "silent.example.test"],
        connectionLimits: { "api.example.test": { total: 1 } },
        seed: `bun -e "${calls}" && ${settings.seed}`,
      };
      await Bun.write(file, JSON.stringify({ ...config, customizations: { "qa-interns": qa } }));
      const git = ["git", "-C", relayed, "-c", "user.name=QA Interns", "-c", "user.email=qa@example.test", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null"];
      await execute([...git, "init", "-q"]);
      await execute([...git, "add", "-A"]);
      await execute([...git, "commit", "-q", "-m", "Relayed Ledger"]);

      const runDir = await runQa({
        dir: relayed,
        rev: "HEAD",
        dirty: false,
        interns: 1,
        minutes: 0.5,
        confirmMinutes: 0.5,
        loginsFile: await logins("relayed", [{ id: "claude-1", provider: "claude" }]),
        replay: null,
        runnerImage: async () => fakeImage,
        print: () => {},
      });

      const state = await readState(runDir);
      expect(state.phase).toBe("done");
      expect(state.interns.map((entry) => [entry.id, entry.status])).toEqual([
        ["i1", "done"],
        ["c1", "done"],
      ]);
      const report = await Bun.file(join(runDir, "findings.json")).json();
      expect(report.egress).toEqual([
        { host: "api.example.test", outcome: "failed", error: "ENOTFOUND", connections: 2, interns: ["i1", "c1"] },
        { host: "api.example.test", outcome: "refused", error: "total", connections: 2, interns: ["i1", "c1"] },
        { host: "silent.example.test", outcome: null, error: null, connections: 0, interns: [] },
        { host: null, outcome: "denied", error: null, connections: 2, interns: ["i1", "c1"] },
      ]);
      const markdown = await Bun.file(join(runDir, "report.md")).text();
      expect(markdown).toContain("| api.example.test | failed | ENOTFOUND | 2 | i1, c1 |\n");
      expect(markdown).toContain("| api.example.test | refused | total | 2 | i1, c1 |\n");
      expect(markdown).toContain("| silent.example.test | no connection |  | 0 |  |\n");
      for (const internId of ["i1", "c1"]) {
        const logs = await readRelayLogs(join(runDir, "interns", internId));
        expect(logs.map((records) => records.map((entry) => entry.n))).toEqual([[1, 2, 3]]);
      }

      expect(await leftovers(state.runId)).toEqual([]);
      expect(await workspaces(runDir, state)).toEqual([]);
      expect(await disks(runDir, state)).toEqual([]);
    },
    timeout,
  );

  test(
    "a replay hands the confirmed group of an earlier run to a confirming intern at a new commit and reports that it reproduced",
    async () => {
      const loginsFile = await logins("replay", [{ id: "claude-1", provider: "claude" }]);
      const sourceDir = await runQa({ dir: target, rev: "HEAD", dirty: false, interns: 1, minutes: 0.5, confirmMinutes: 0.5, loginsFile, replay: null, runnerImage: async () => fakeImage, print: () => {} });
      const source = await readState(sourceDir);
      const git = ["git", "-C", join(root, "repo"), "-c", "user.name=QA Interns", "-c", "user.email=qa@example.test", "-c", "commit.gpgsign=false"];
      const next = (await execute([...git, "commit-tree", "-p", source.target.commit, "-m", "Next", `${source.target.commit}^{tree}`])).trim();
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
          replay: await readReplay(sourceDir, []),
          runnerImage: async () => fakeImage,
          print: (line) => failedLines.push(line),
        }),
      ).rejects.toThrow("No confirming intern recorded a result: c1 done: confirmation failed: no confirmation.json written");
      const failedDir = failedLines[0] ?? "";
      const failed = await readState(failedDir);
      expect(failed.phase).toBe("failed");
      const failedReport = await Bun.file(join(failedDir, "findings.json")).json();
      expect(failedReport.run).toMatchObject({ reproducedGroups: 0, notReproducedGroups: 0, uncheckedGroups: 1 });
      expect(failedReport.groups[0]).toMatchObject({ id: "g1", reproduced: null, confirmation: { intern: "c1", result: null, error: "no confirmation.json written" } });

      for (const [dir, run] of [
        [sourceDir, source],
        [runDir, state],
        [failedDir, failed],
      ] as const) {
        expect(await leftovers(run.runId)).toEqual([]);
        expect(await workspaces(dir, run)).toEqual([]);
        expect(await disks(dir, run)).toEqual([]);
      }
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
          blocked = Bun.spawnSync(["docker", "network", "create", "--internal", "--subnet", first, blocker], { stdout: "ignore" }).exitCode;
        },
      }).finally(async () => {
        if (blocked === 0) await execute(["docker", "network", "rm", blocker]);
      });

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
    "environments start in a block of the range that QA_INTERNS_SUBNET sets that no Docker network overlaps, and a run fails when every block overlaps one",
    async () => {
      const third = await freeBlock(214);
      const subnet = `10.214.${third}.0/22`;
      const blockers: string[] = [];
      const block = async (range: string) => {
        const name = `qair-f-e2e-${id}-range-${blockers.length}`;
        await execute(["docker", "network", "create", "--internal", "--subnet", range, name]);
        blockers.push(name);
      };
      const previous = process.env.QA_INTERNS_SUBNET;
      process.env.QA_INTERNS_SUBNET = subnet;
      try {
        await block(`10.214.${third}.0/25`);
        const loginsFile = await logins("range", [{ id: "claude-1", provider: "claude" }]);
        const run = () => runQa({ dir: target, rev: "HEAD", dirty: false, interns: 1, minutes: 0.5, confirmMinutes: 0.5, loginsFile, replay: null, runnerImage: async () => fakeImage, print: () => {} });
        const runDir = await run();
        const state = await readState(runDir);
        expect(state.phase).toBe("done");
        expect(state.interns.map((entry) => [entry.id, entry.status])).toEqual([
          ["i1", "done"],
          ["c1", "done"],
        ]);
        expect(internalSubnet(runDir, "i1")).toBe(`10.214.${third + 2}.0/25`);
        expect(internalSubnet(runDir, "c1")).toBe(`10.214.${third + 2}.0/25`);
        expect(await leftovers(state.runId)).toEqual([]);

        await block(`10.214.${third + 3}.128/25`);
        await expect(run()).rejects.toThrow(`No free network slot: every /23 block of QA_INTERNS_SUBNET ${subnet} overlaps a Docker network or a host route`);
      } finally {
        if (previous === undefined) delete process.env.QA_INTERNS_SUBNET;
        else process.env.QA_INTERNS_SUBNET = previous;
        if (blockers.length > 0) await execute(["docker", "network", "rm", ...blockers]);
      }
    },
    timeout,
  );

  test(
    "ask returns the file the agent wrote, leaves nothing of its environment, and leaves other projects of the run alone",
    async () => {
      const runId = newRunId();
      const other = `qair-f-e2e-other-${runId}`;
      const sibling = join(root, "asks", runId, "envs", "i1", `qa-${runId}-i1`, "marker");
      await Bun.write(sibling, "sibling copy\n");
      await execute(["docker", "network", "create", "--internal", "--label", `com.docker.compose.project=qa-${runId}-i1`, other]);
      try {
        expect(await ask(await askOptions(runId, "score"))).toEqual({ groups: [] });
        expect((await capture(["docker", "network", "inspect", other])).code).toBe(0);
      } finally {
        if ((await capture(["docker", "network", "inspect", other])).code === 0) await execute(["docker", "network", "rm", other]);
      }
      expect(await leftovers(runId)).toEqual([]);
      expect(await readdir(join(root, "asks", runId, "interns", "score"))).not.toContain("out.img");
      expect(await readdir(join(root, "asks", runId, "envs", "score"))).not.toContain("tmp");
      expect(await Bun.file(sibling).text()).toBe("sibling copy\n");
    },
    timeout,
  );

  test(
    "ask fails when its environment cannot be torn down, after removing what it can",
    async () => {
      const runId = newRunId();
      const project = `qa-${runId}-score`;
      const held = `qair-f-e2e-held-${runId}`;
      await execute(["docker", "network", "create", "--internal", "--label", `com.docker.compose.project=${project}`, held]);
      try {
        await execute(["docker", "run", "-d", "--rm", "--name", held, "--network", held, fakeImage]);
        await expect(ask(await askOptions(runId, "score"))).rejects.toThrow(`Teardown of ${project} failed: score: docker compose down left objects of ${project} behind`);
      } finally {
        await execute(["docker", "rm", "-f", held]);
        await execute(["docker", "network", "rm", held]);
        await removeCopies(join(root, "asks", runId), runId, fakeImage);
      }
      expect(await leftovers(runId)).toEqual([]);
      expect(await readdir(join(root, "asks", runId, "interns", "score"))).not.toContain("out.img");
    },
    timeout,
  );

  test(
    "ask waits for a login that another process holds and runs once that process ends, and fails at once when no process holds a login",
    async () => {
      const runId = newRunId();
      const options = await askOptions(runId, "score");
      const script = join(root, "holder.ts");
      await Bun.write(
        script,
        [
          `import { loadLogins, Scheduler } from ${JSON.stringify(join(import.meta.dir, "..", "src", "logins.ts"))};`,
          "const lease = await new Scheduler(await loadLogins(process.argv[2])).acquire(\"h1\");",
          "console.log(lease === null ? \"none\" : \"held\");",
          "for await (const _ of Bun.stdin.stream()) {}",
          "",
        ].join("\n"),
      );
      const holder = Bun.spawn([process.execPath, script, options.loginsFile], { env: { ...process.env }, stdin: "pipe", stdout: "pipe", stderr: "inherit" });
      try {
        const { value } = await holder.stdout.getReader().read();
        expect(new TextDecoder().decode(value).trim()).toBe("held");
        let settled = false;
        const answer = ask(options).finally(() => {
          settled = true;
        });
        await Bun.sleep(3_000);
        expect(settled).toBe(false);
        holder.stdin.end();
        await holder.exited;
        expect(await answer).toEqual({ groups: [] });
      } finally {
        holder.kill("SIGKILL");
        await holder.exited;
      }
      expect(await leftovers(runId)).toEqual([]);

      const seatless = await askOptions(newRunId(), "score");
      const file = join(root, `seatless-${runId}-logins.json`);
      await Bun.write(file, JSON.stringify({ logins: [{ id: "claude-seatless", provider: "claude", seat: ["false"] }] }));
      await expect(ask({ ...seatless, loginsFile: file })).rejects.toThrow("No login has spare capacity for score");
      expect(await leftovers(seatless.runId)).toEqual([]);
    },
    timeout,
  );

  test(
    "an intern does not start when devcontainer up gives its dev container host access",
    async () => {
      const hostile = join(root, "hostile");
      await cp(target, hostile, { recursive: true });
      const file = join(hostile, ".devcontainer", "devcontainer.json");
      const config = await Bun.file(file).json();
      const hostileSettings = {
        customizations: { "qa-interns": { ...config.customizations["qa-interns"], hostEnv: ["QA_PROBE_DIR"] } },
        dockerComposeFile: ["compose.yml", "results.yml"],
        capAdd: ["SYS_PTRACE"],
        securityOpt: ["no-new-privileges:true\n    cgroup: host"],
        mounts: ["source=${QA_PROBE_DIR},target=/probe\n  db:\n    cap_add: [NET_ADMIN],type=bind"],
      };
      await Bun.write(file, JSON.stringify({ ...config, ...hostileSettings }));
      await Bun.write(join(hostile, ".devcontainer", "results.yml"), 'services:\n  web:\n    volumes: ["../results:/results"]\n');
      await symlink("../../../interns", join(hostile, "results"));
      const git = ["git", "-C", hostile, "-c", "user.name=QA Interns", "-c", "user.email=qa@example.test", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null"];
      await execute([...git, "init", "-q"]);
      await execute([...git, "add", "-A"]);
      await execute([...git, "commit", "-q", "-m", "Hostile Ledger"]);
      const probe = join(root, "probe");
      await mkdir(probe);
      const loginsFile = await logins("hostile", [{ id: "claude-1", provider: "claude" }]);

      const lines: string[] = [];
      const previous = process.env.QA_PROBE_DIR;
      process.env.QA_PROBE_DIR = probe;
      let error: unknown = null;
      try {
        await runQa({ dir: hostile, rev: "HEAD", dirty: false, interns: 1, minutes: 0.5, confirmMinutes: 0.5, loginsFile, replay: null, runnerImage: async () => fakeImage, print: (line) => lines.push(line) });
      } catch (reason) {
        error = reason;
      } finally {
        if (previous === undefined) delete process.env.QA_PROBE_DIR;
        else process.env.QA_PROBE_DIR = previous;
      }

      expect(error).toBeInstanceOf(Error);
      const runDir = lines[0] ?? "";
      const state = await readState(runDir);
      expect(state.phase).toBe("failed");
      const failed = intern(state, "i1");
      expect(failed.status).toBe("failed");
      expect(failed.model).toBeNull();
      expect(failed.detail).toContain(`The dev container that devcontainer up created for qa-${state.runId}-i1 cannot run as isolated copies`);
      expect(failed.detail).toContain("devcontainer up changes cgroup of service web");
      expect(failed.detail).toContain("devcontainer up changes service db");
      expect(failed.detail).toContain("service db adds capability NET_ADMIN");
      expect(failed.detail).toContain(`/results, which resolves to ${await realpath(runDir)}/interns, outside the target directory`);
      expect(failed.detail).toContain("service web sets cgroup host");
      expect(failed.detail).toContain("service web adds capability SYS_PTRACE");
      expect(failed.detail).toContain(`service web mounts ${probe}, which resolves to ${await realpath(probe)}, outside the target directory`);
      expect(await Bun.file(join(runDir, "interns", "i1", "transcript.jsonl")).exists()).toBe(false);
      const [environment, ...others] = (await Bun.file(join(runDir, "findings.json")).json()).environments as EnvironmentStats[];
      expect(others).toEqual([]);
      expect(environment).toMatchObject({ intern: "i1", attempt: 1, readyAt: null });
      expect(environment?.containers?.map((container) => container.service)).toContain("web");

      expect(await leftovers(state.runId)).toEqual([]);
      expect(await workspaces(runDir, state)).toEqual([]);
      expect(await disks(runDir, state)).toEqual([]);
    },
    timeout,
  );

  test(
    "a run replaces every value that secrets names with [redacted] in the files it leaves and the lines it prints",
    async () => {
      const secret = join(root, "secret");
      await cp(target, secret, { recursive: true });
      const file = join(secret, ".devcontainer", "devcontainer.json");
      const config = await Bun.file(file).json();
      const settings = { ...config.customizations["qa-interns"], hostEnv: ["QA_SECRET_TOKEN"], secrets: { hostEnv: ["QA_SECRET_TOKEN"], seed: ["password"] } };
      await Bun.write(file, JSON.stringify({ ...config, initializeCommand: 'echo "initialize with $QA_SECRET_TOKEN" >&2', customizations: { "qa-interns": settings } }));
      const git = ["git", "-C", secret, "-c", "user.name=QA Interns", "-c", "user.email=qa@example.test", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null"];
      await execute([...git, "init", "-q"]);
      await execute([...git, "add", "-A"]);
      await execute([...git, "commit", "-q", "-m", "Ledger with secrets"]);
      const token = `tok_${crypto.randomUUID()}`;
      const passwords = ["acme-owner-pass", "acme-editor-pass", "acme-viewer-pass", "globex-owner-pass"];
      const loginsFile = await logins("secret", [{ id: "claude-1", provider: "claude", stray: true }]);

      const lines: string[] = [];
      const previous = process.env.QA_SECRET_TOKEN;
      process.env.QA_SECRET_TOKEN = token;
      const stderr = spyOn(process.stderr, "write");
      let runDir: string;
      let printed: string;
      try {
        runDir = await runQa({ dir: secret, rev: "HEAD", dirty: false, interns: 1, minutes: 0.5, confirmMinutes: 0.5, loginsFile, replay: null, runnerImage: async () => fakeImage, print: (line) => lines.push(line) });
      } finally {
        printed = stderr.mock.calls.map(([chunk]) => String(chunk)).join("");
        stderr.mockRestore();
        if (previous === undefined) delete process.env.QA_SECRET_TOKEN;
        else process.env.QA_SECRET_TOKEN = previous;
      }
      expect(printed).toContain("Got response to unknown request [redacted]\n");
      expect(printed).toContain("Invalid message\n");
      expect(passwords.filter((value) => printed.includes(value))).toEqual([]);

      const state = await readState(runDir);
      expect(state.phase).toBe("done");
      expect(redact(token)).toBe(token);
      const entries = await readdir(runDir, { recursive: true, withFileTypes: true });
      const files = entries.filter((entry) => entry.isFile()).map((entry) => join(entry.parentPath, entry.name)).filter((path) => !path.startsWith(join(runDir, "source", "")));
      expect(files).toContain(join(runDir, "interns", "c1", "transcript.jsonl"));
      for (const path of files) {
        const text = readFileSync(path, "latin1");
        expect([path, [token, ...passwords].filter((value) => text.includes(value))]).toEqual([path, []]);
      }
      expect([token, ...passwords].filter((value) => lines.join("\n").includes(value))).toEqual([]);
      const text = (path: string[]) => readFileSync(join(runDir, ...path), "utf8");
      expect(text(["envs", "i1", "env.log"])).toContain("initialize with [redacted]");
      expect(text(["interns", "i1", "out", "evidence", "prompt.txt"])).toContain('"password": "[redacted]"');
      expect(text(["interns", "i1", "transcript.jsonl"])).toContain('\\"password\\": \\"[redacted]\\"');
      expect(text(["interns", "i1", "transcript.jsonl"])).toContain('"text":"Signed in as owner@acme.test with [redacted]"');
      expect(text(["interns", "i1", "transcript.jsonl"])).not.toContain("ner-pass.");
      expect(JSON.parse(text(["interns", "i1", "out", "findings", "fake-home.json"])).steps).toContain("Sign in as owner@acme.test with the password [redacted].");
      const report = JSON.parse(text(["findings.json"]));
      expect(report.groups[0].findings[0].steps).toContain("Sign in as owner@acme.test with the password [redacted].");
      expect(text(["report.md"])).toContain("Sign in as owner@acme.test with the password \\[redacted\\].");

      expect(await leftovers(state.runId)).toEqual([]);
      expect(await workspaces(runDir, state)).toEqual([]);
      expect(await disks(runDir, state)).toEqual([]);
    },
    timeout,
  );

  test(
    "a run and ask replace the API key of an OpenCode login with [redacted] in the files they leave, the lines run prints, and the errors ask throws",
    async () => {
      const key = `sk-or-v1-${crypto.randomUUID()}`;
      const loginsFile = await logins("login-key", [{ id: "opencode-1", provider: "opencode", openrouter: { type: "api", key } }]);
      const lines: string[] = [];
      const runDir = await runQa({ dir: target, rev: "HEAD", dirty: false, interns: 1, minutes: 0.5, confirmMinutes: 0.5, loginsFile, replay: null, runnerImage: async () => fakeImage, print: (line) => lines.push(line) });

      const state = await readState(runDir);
      expect(state.phase).toBe("done");
      expect(intern(state, "i1").provider).toBe("opencode");
      const options = { runDir, runId: state.runId, loginsFile, runnerImage: fakeImage };
      expect(await ask({ ...options, name: "score", prompt: "Write /qa/out/groups.json.", file: "groups.json", parse: (raw) => JSON.parse(raw) })).toEqual({ groups: [] });
      const failed = ask({
        ...options,
        name: "score-fail",
        prompt: "Write /qa/out/evidence/auth.json.",
        file: "evidence/auth.json",
        parse: (raw) => {
          throw new Error(`unreadable ${raw}`);
        },
      });
      await expect(failed).rejects.toThrow('/qa/out/evidence/auth.json is still invalid after one correction: unreadable {"openrouter":{"type":"api","key":"[redacted]"}}');
      expect(redact(key)).toBe(key);
      const entries = await readdir(runDir, { recursive: true, withFileTypes: true });
      const files = entries.filter((entry) => entry.isFile()).map((entry) => join(entry.parentPath, entry.name));
      for (const path of files) expect([path, readFileSync(path, "latin1").includes(key)]).toEqual([path, false]);
      expect(lines.join("\n")).not.toContain(key);
      for (const name of ["i1", "score", "score-fail"]) {
        expect(readFileSync(join(runDir, "interns", name, "transcript.jsonl"), "utf8")).toContain('"text":"The login key is [redacted]."');
        expect(JSON.parse(readFileSync(join(runDir, "interns", name, "out", "evidence", "auth.json"), "utf8"))).toEqual({ openrouter: { type: "api", key: "[redacted]" } });
      }

      expect(await leftovers(state.runId)).toEqual([]);
      expect(await workspaces(runDir, state)).toEqual([]);
      expect(await disks(runDir, state)).toEqual([]);
    },
    timeout,
  );

  test(
    "up leaves one ready and seeded environment with its relay and a runner without a login, and down removes it",
    async () => {
      const relayed = join(root, "relayed");
      await cp(target, relayed, { recursive: true });
      const file = join(relayed, ".devcontainer", "devcontainer.json");
      const config = await Bun.file(file).json();
      config.customizations["qa-interns"].egress = ["api.pwnedpasswords.com"];
      await Bun.write(file, JSON.stringify(config));
      const git = ["git", "-C", relayed, "-c", "user.name=QA Interns", "-c", "user.email=qa@example.test", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null"];
      await execute([...git, "init", "-q"]);
      await execute([...git, "add", "-A"]);
      await execute([...git, "commit", "-q", "-m", "Relayed Ledger"]);
      config.customizations["qa-interns"].seed = "echo not-json";
      await Bun.write(file, JSON.stringify(config));
      await execute([...git, "commit", "-q", "-a", "-m", "Broken seed"]);

      const cli = (...args: string[]) => capture([process.execPath, join(import.meta.dir, "..", "src", "cli.ts"), ...args], { env: { ...process.env } });
      const up = await cli("up", relayed, "--commit", "HEAD~1");
      const lines = up.stdout.trim().split("\n");
      const runDir = lines[0] ?? "";
      let removed = false;
      try {
        expect(up).toMatchObject({ code: 0 });
        expect(runDir).toStartWith(join(root, "state"));
        const state = await readState(runDir);
        expect(state).toMatchObject({ phase: "up", error: null, interns: [] });
        const project = `qa-${state.runId}-up`;
        const container = async (service: string) => (await execute(["docker", "compose", "-p", project, "ps", "-q", service])).trim();
        const runner = await container("qa-runner");
        const [seed = ""] = lines.filter((line) => line.startsWith("seed "));
        expect(lines.filter((line) => !line.startsWith("seed "))).toEqual([
          runDir,
          "phase preparing",
          "phase building",
          "phase starting",
          "phase up",
          `project ${project}`,
          `runner ${runner}`,
          `dev container ${await container("web")}`,
          `Remove it with qa-interns down ${state.runId}.`,
        ]);
        expect(JSON.parse(seed.slice("seed ".length))).toMatchObject({ data: { acmeInvoiceCount: 23, globexInvoiceCount: 3 } });

        const services = await execute(["docker", "ps", "--filter", `label=com.docker.compose.project=${project}`, "--format", '{{.Label "com.docker.compose.service"}}']);
        expect(services.trim().split("\n").sort()).toEqual(["db", "qa-relay", "qa-runner", "web"]);
        expect(await execute(["docker", "exec", runner, "curl", "-sS", "-o", "/dev/null", "-w", "%{http_code}", "http://web:3000/health"])).toBe("200");
        const mounts: { Destination: string }[] = JSON.parse(await execute(["docker", "inspect", "--format", "{{json .Mounts}}", runner]));
        expect(mounts.map((mount) => mount.Destination).sort()).toEqual(["/etc/opt/chrome_for_testing/policies/managed/qa-interns.json", "/qa/out"]);
        const networks = JSON.parse(await execute(["docker", "inspect", "--format", "{{json .NetworkSettings.Networks}}", runner]));
        expect(Object.keys(networks)).toEqual([`${project}_qa_internal`]);

        const down = await cli("down", runDir);
        expect(down).toMatchObject({ code: 0, stdout: `Run ${state.runId} has no environments left.\n` });
        removed = true;
        expect(await readState(runDir)).toMatchObject({ phase: "done", error: null });
        expect(await leftovers(state.runId)).toEqual([]);
        expect((await readdir(join(runDir, "envs", "up"))).filter((entry) => entry === project || entry === "tmp")).toEqual([]);
        expect((await readdir(join(runDir, "interns", "up"))).filter((entry) => entry.includes(".img"))).toEqual([]);
        expect(readFileSync("/proc/self/mountinfo", "utf8")).not.toContain(runDir);
      } finally {
        if (!removed && runDir !== "") expect(await cli("down", runDir)).toMatchObject({ code: 0 });
      }

      const broken = await cli("up", relayed);
      expect(broken.code).toBe(1);
      expect(broken.stderr).toContain("The seed command echo not-json did not print one JSON document");
      const failed = await readState(broken.stdout.split("\n")[0] ?? "");
      expect(failed).toMatchObject({ phase: "failed" });
      expect(failed.error).toStartWith("The seed command echo not-json did not print one JSON document");
      expect(await leftovers(failed.runId)).toEqual([]);
    },
    timeout,
  );

  test(
    "up and a failed up replace every hostEnv value that secrets names with [redacted] in the files they leave, and a running up leaves its live workspace untouched",
    async () => {
      const secret = join(root, "up-secret");
      await cp(target, secret, { recursive: true });
      const file = join(secret, ".devcontainer", "devcontainer.json");
      const config = await Bun.file(file).json();
      const settings = { ...config.customizations["qa-interns"], hostEnv: ["QA_SECRET_TOKEN"], secrets: { hostEnv: ["QA_SECRET_TOKEN"] } };
      const initializeCommand = 'echo "initialize with $QA_SECRET_TOKEN" >&2 && printf %s "$QA_SECRET_TOKEN" > live-secret.txt';
      await Bun.write(file, JSON.stringify({ ...config, initializeCommand, customizations: { "qa-interns": settings } }));
      const git = ["git", "-C", secret, "-c", "user.name=QA Interns", "-c", "user.email=qa@example.test", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null"];
      await execute([...git, "init", "-q"]);
      await execute([...git, "add", "-A"]);
      await execute([...git, "commit", "-q", "-m", "Ledger with a secret"]);
      await Bun.write(file, JSON.stringify({ ...config, initializeCommand, customizations: { "qa-interns": { ...settings, seed: "echo not-json" } } }));
      await execute([...git, "commit", "-q", "-a", "-m", "Broken seed"]);
      const token = `tok_${crypto.randomUUID()}`;
      const cli = (...args: string[]) =>
        capture([process.execPath, join(import.meta.dir, "..", "src", "cli.ts"), ...args], { env: { ...process.env, QA_SECRET_TOKEN: token } });
      const leaks = async (runDir: string) => {
        const entries = await readdir(runDir, { recursive: true, withFileTypes: true });
        const files = entries.filter((entry) => entry.isFile()).map((entry) => join(entry.parentPath, entry.name)).filter((path) => !path.startsWith(join(runDir, "source", "")));
        return files.filter((path) => readFileSync(path, "latin1").includes(token));
      };

      const up = await cli("up", secret, "--commit", "HEAD~1");
      const runDir = up.stdout.split("\n")[0] ?? "";
      try {
        expect(up).toMatchObject({ code: 0 });
        const live = join(runDir, "envs", "up", `qa-${(await readState(runDir)).runId}-up`, "live-secret.txt");
        expect(await leaks(runDir)).toEqual([live]);
        expect(readFileSync(live, "utf8")).toBe(token);
        expect(readFileSync(join(runDir, "envs", "up", "env.log"), "utf8")).toContain("initialize with [redacted]");
      } finally {
        if (runDir !== "") expect(await cli("down", runDir)).toMatchObject({ code: 0 });
      }

      const broken = await cli("up", secret);
      expect(broken.code).toBe(1);
      const failedDir = broken.stdout.split("\n")[0] ?? "";
      expect(await readState(failedDir)).toMatchObject({ phase: "failed" });
      expect(await leaks(failedDir)).toEqual([]);
      expect(readFileSync(join(failedDir, "envs", "up", "env.log"), "utf8")).toContain("initialize with [redacted]");
      expect(await leftovers((await readState(failedDir)).runId)).toEqual([]);
    },
    timeout,
  );

  test(
    "an intern that fills its 1 GiB disk, partly with a deleted file it keeps open, is stopped and keeps its findings",
    async () => {
      const lines: string[] = [];
      const ended = join(root, "flood-ended.txt");
      const run = runQa({
        dir: target,
        rev: "HEAD",
        dirty: false,
        interns: 1,
        minutes: 5,
        confirmMinutes: 0.5,
        loginsFile: await logins("flood", [{ id: "claude-flood", provider: "claude", flood: true }]),
        replay: null,
        onEnd: `printf '%s\\n' "$QA_INTERNS_RUN_DIR" "$QA_INTERNS_PHASE" > '${ended}'; exit 3`,
        runnerImage: async () => fakeImage,
        print: (line) => lines.push(line),
      });

      await expect(run).rejects.toThrow("No testing intern completed");
      await expect(run).rejects.toThrow("; The --on-end command exited with 3");
      const runDir = lines[0];
      if (runDir === undefined) throw new Error("runQa printed no run directory");
      expect(await Bun.file(ended).text()).toBe(`${runDir}\nfailed\n`);
      const state = await readState(runDir);
      expect(state.phase).toBe("failed");
      expect(intern(state, "i1")).toMatchObject({
        status: "failed",
        findings: 1,
        detail: `${join(runDir, "interns", "i1", "out")} filled its 1 GiB disk, so its runner was stopped`,
      });
      const big = Bun.file(join(runDir, "interns", "i1", "out", "evidence", "big.bin")).size;
      expect(big).toBeGreaterThan(0);
      expect(big).toBeLessThan(1024 ** 3 - 600 * 1024 ** 2);
      expect(await Bun.file(join(runDir, "interns", "i1", "out", "evidence", "held.bin")).exists()).toBe(false);

      const report = await Bun.file(join(runDir, "findings.json")).json();
      expect(report.groups.map((group: { findings: { id: string }[] }) => group.findings.map((finding) => finding.id))).toEqual([["i1/fake-home"]]);

      expect(await leftovers(state.runId)).toEqual([]);
      expect(await workspaces(runDir, state)).toEqual([]);
      expect(await disks(runDir, state)).toEqual([]);
    },
    timeout,
  );

  test(
    "a run that SIGTERM interrupts tears down, runs its --on-end command, and exits 130 when that command fails",
    async () => {
      const ended = join(root, "interrupt-ended.txt");
      const cli = Bun.spawn(
        [
          process.execPath,
          cliScript,
          "run",
          target,
          "--interns",
          "1",
          "--logins",
          await logins("interrupt", [{ id: "claude-1", provider: "claude" }]),
          "--on-end",
          `printf '%s\\n' "$QA_INTERNS_RUN_DIR" "$QA_INTERNS_PHASE" > '${ended}'; echo 'no notification' >&2; exit 3`,
        ],
        { env: { ...process.env }, stdin: "ignore", stdout: "pipe", stderr: "pipe" },
      );
      const reader = cli.stdout.getReader();
      const decoder = new TextDecoder();
      let out = "";
      while (!out.includes("\n")) {
        const chunk = await reader.read();
        if (chunk.done) throw new Error(`run exited before it printed its run directory: ${await new Response(cli.stderr).text()}`);
        out += decoder.decode(chunk.value, { stream: true });
      }
      const runDir = out.slice(0, out.indexOf("\n"));
      while (!existsSync(join(runDir, "source")) && cli.exitCode === null) await Bun.sleep(50);
      cli.kill("SIGTERM");
      const [code, stderr] = await Promise.all([cli.exited, new Response(cli.stderr).text()]);

      expect(code).toBe(130);
      expect(stderr).toContain("no notification\nThe --on-end command exited with 3\n");
      expect(await Bun.file(ended).text()).toBe(`${runDir}\nfailed\n`);
      const state = await readState(runDir);
      expect(state).toMatchObject({ phase: "failed", error: "interrupted" });
      expect(await leftovers(state.runId)).toEqual([]);
    },
    timeout,
  );

  test(
    "down stops a failed run whose --on-end command is still running",
    async () => {
      const bare = join(root, "bare");
      await mkdir(bare);
      await Bun.write(join(bare, "README.md"), "No dev container.\n");
      const git = ["git", "-C", bare, "-c", "user.name=QA Interns", "-c", "user.email=qa@example.test", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null"];
      await execute([...git, "init", "-q"]);
      await execute([...git, "add", "-A"]);
      await execute([...git, "commit", "-q", "-m", "No dev container"]);
      const ended = join(root, "down-ended.txt");
      const child = join(root, "down-child.txt");
      const cli = Bun.spawn(
        [
          process.execPath,
          cliScript,
          "run",
          bare,
          "--logins",
          await logins("down", [{ id: "claude-1", provider: "claude" }]),
          "--on-end",
          `sleep 600 & echo $! > '${child}'; printf '%s\\n' "$QA_INTERNS_RUN_DIR" "$QA_INTERNS_PHASE" > '${ended}.tmp' && mv '${ended}.tmp' '${ended}'; wait`,
        ],
        { env: { ...process.env }, stdin: "ignore", stdout: "ignore", stderr: "pipe" },
      );
      while (!existsSync(ended) && cli.exitCode === null) await Bun.sleep(50);
      const [runDir = "", phase] = (await Bun.file(ended).text()).split("\n");
      expect(phase).toBe("failed");
      const sleeper = Number((await Bun.file(child).text()).trim());
      const alive = () => {
        try {
          return !readFileSync(`/proc/${sleeper}/stat`, "utf8").includes(") Z ");
        } catch (error) {
          if (errorCode(error) === "ENOENT") return false;
          throw error;
        }
      };
      expect(alive()).toBe(true);

      const down = await capture([process.execPath, cliScript, "down", runDir], { env: { ...process.env } });
      expect(down.code).toBe(0);
      expect(down.stdout).toContain(`(process ${cli.pid})`);
      expect(await cli.exited).toBe(130);
      for (let tries = 0; tries < 100 && alive(); tries += 1) await Bun.sleep(50);
      expect(alive()).toBe(false);
      expect(await new Response(cli.stderr).text()).toContain("The --on-end command exited with");
      expect(await readState(runDir)).toMatchObject({ phase: "failed" });
    },
    timeout,
  );

  test(
    "a dirty run serves the uncommitted changes and untracked files of the working tree and records the run as dirty",
    async () => {
      const dirty = join(root, "dirty");
      await cp(target, dirty, { recursive: true });
      const git = ["git", "-C", dirty, "-c", "user.name=QA Interns", "-c", "user.email=qa@example.test", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null"];
      await execute([...git, "init", "-q"]);
      await execute([...git, "add", "-A"]);
      await execute([...git, "commit", "-q", "-m", "Ledger"]);
      const head = (await execute([...git, "rev-parse", "HEAD"])).trim();
      const html = join(dirty, "src", "html.ts");
      const page = (await Bun.file(html).text()).replace("<h1>Sign in to Ledger</h1>", "<h1>Sign in to Ledger</h1>${notice}");
      await Bun.write(html, `import { notice } from "./notice.ts";\n${page}`);
      await Bun.write(join(dirty, "src", "notice.ts"), 'export const notice = "<p id=\\"notice\\">Uncommitted notice</p>";\n');
      await Bun.write(join(dirty, "node_modules", "ignored.txt"), "ignored\n");

      const lines: string[] = [];
      const runDir = await runQa({
        dir: dirty,
        rev: "HEAD",
        dirty: true,
        interns: 1,
        minutes: 0.5,
        confirmMinutes: 0.5,
        loginsFile: await logins("dirty", [{ id: "claude-1", provider: "claude" }]),
        replay: null,
        runnerImage: async () => fakeImage,
        print: (line) => lines.push(line),
      });

      const state = await readState(runDir);
      expect(state).toMatchObject({ phase: "done", error: null, target: { path: "", commit: head, dirty: true } });
      expect(await Bun.file(join(runDir, "interns", "i1", "out", "evidence", "page.html")).text()).toContain('<p id="notice">Uncommitted notice</p>');
      expect(await Bun.file(join(runDir, "source", "node_modules", "ignored.txt")).exists()).toBe(false);
      const report = await Bun.file(join(runDir, "findings.json")).json();
      expect(report.run.target).toEqual(state.target);
      expect(report.groups[0].findings[0].environment).toEqual({ commit: head, dirty: true, environment: `qa-${state.runId}-i1`, provider: "claude", model: "fake-model-1" });
      expect((await Bun.file(join(runDir, "report.md")).text()).split("\n")).toContain(`- Commit: \`${head}\`, with the uncommitted changes and untracked files of the working tree`);

      expect(await leftovers(state.runId)).toEqual([]);
      expect(await workspaces(runDir, state)).toEqual([]);
      expect(await disks(runDir, state)).toEqual([]);
    },
    timeout,
  );
});
