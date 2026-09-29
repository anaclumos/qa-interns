import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { cp, mkdir, readdir, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { removeCopies, writeChromePolicy } from "../src/environment.ts";
import { ask, runQa, type AskOptions } from "../src/run.ts";
import { ensureRunnerImage } from "../src/runner.ts";
import { newRunId, readState } from "../src/state.ts";
import { capture, execute } from "../src/target.ts";
import type { Finding, Provider, RunState } from "../src/types.ts";

const dockerAvailable = Bun.spawnSync(["docker", "info"], { stdout: "ignore", stderr: "ignore" }).exitCode === 0;

const id = crypto.randomUUID().slice(0, 8);
const root = join(tmpdir(), `qair-f-e2e-${id}`);
const fakeImage = `qair-f-e2e-runner:${id}`;
const target = join(root, "repo", "eval", "ledger");
const previousStateHome = process.env.XDG_STATE_HOME;
const timeout = 20 * 60_000;
const title = "Home page shows the fake defect";
const knownGap = "The environment has no video model.";
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
      const [charterPrompt, confirmationPrompt] = await Promise.all(["i1", "c1"].map((internId) => firstPrompt(runDir, internId)));
      expect(charterPrompt).toContain(`  - ${knownGap}`);
      expect(confirmationPrompt).toContain("/qa/out/confirmation.json");
      expect(confirmationPrompt).not.toContain(knownGap);

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
      expect(await Bun.file(join(runDir, "interns", "i1", "out", "evidence", "browser.json")).json()).toEqual({
        isSecureContext: true,
        randomUUID: "function",
        subtle: "object",
        clipboard: "object",
      });

      const markdown = await Bun.file(join(runDir, "report.md")).text();
      const confirmed = markdown.slice(markdown.indexOf("## Confirmed"), markdown.indexOf("## Seen once"));
      expect(confirmed).toContain(`### ${title}`);
      expect(confirmed).toContain("- Reproductions: 3 (i1, i2, c1)");

      expect(await leftovers(state.runId)).toEqual([]);
      expect(await workspaces(runDir, state)).toEqual([]);
      expect(await disks(runDir, state)).toEqual([]);
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
      expect(await disks(runDir, state)).toEqual([]);
    },
    timeout,
  );

  test(
    "ask returns the file the agent wrote, leaves nothing of its environment, and leaves other projects of the run alone",
    async () => {
      const runId = newRunId();
      const other = `qair-f-e2e-other-${runId}`;
      await execute(["docker", "network", "create", "--internal", "--label", `com.docker.compose.project=qa-${runId}-i1`, other]);
      try {
        expect(await ask(await askOptions(runId, "score"))).toEqual({ groups: [] });
        expect((await capture(["docker", "network", "inspect", other])).code).toBe(0);
      } finally {
        if ((await capture(["docker", "network", "inspect", other])).code === 0) await execute(["docker", "network", "rm", other]);
      }
      expect(await leftovers(runId)).toEqual([]);
      expect(await readdir(join(root, "asks", runId, "interns", "score"))).not.toContain("out.img");
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
        await runQa({ dir: hostile, rev: "HEAD", interns: 1, minutes: 0.5, confirmMinutes: 0.5, loginsFile, runnerImage: async () => fakeImage, print: (line) => lines.push(line) });
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
      const loginsFile = await logins("secret", [{ id: "claude-1", provider: "claude" }]);

      const lines: string[] = [];
      const previous = process.env.QA_SECRET_TOKEN;
      process.env.QA_SECRET_TOKEN = token;
      let runDir: string;
      try {
        runDir = await runQa({ dir: secret, rev: "HEAD", interns: 1, minutes: 0.5, confirmMinutes: 0.5, loginsFile, runnerImage: async () => fakeImage, print: (line) => lines.push(line) });
      } finally {
        if (previous === undefined) delete process.env.QA_SECRET_TOKEN;
        else process.env.QA_SECRET_TOKEN = previous;
      }

      const state = await readState(runDir);
      expect(state.phase).toBe("done");
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
    "an intern that fills its 1 GiB disk, partly with a deleted file it keeps open, is stopped and keeps its findings",
    async () => {
      const lines: string[] = [];
      const run = runQa({
        dir: target,
        rev: "HEAD",
        interns: 1,
        minutes: 5,
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
});
