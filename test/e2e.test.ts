import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { cp, mkdir, readdir, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { runQa } from "../src/run.ts";
import { ensureRunnerImage } from "../src/runner.ts";
import { readState } from "../src/state.ts";
import { execute } from "../src/target.ts";
import type { RunState } from "../src/types.ts";

const dockerAvailable = Bun.spawnSync(["docker", "info"], { stdout: "ignore", stderr: "ignore" }).exitCode === 0;

const id = crypto.randomUUID().slice(0, 8);
const root = join(tmpdir(), `qair-f-e2e-${id}`);
const fakeImage = `qair-f-e2e-runner:${id}`;
const target = join(root, "repo", "eval", "ledger");
const previousStateHome = process.env.XDG_STATE_HOME;
const timeout = 20 * 60_000;
const title = "Home page shows the fake defect";
let built = false;

async function logins(name: string, entries: { id: string; limit: boolean }[]): Promise<string> {
  const list = [];
  for (const entry of entries) {
    const store = join(root, "stores", name, entry.id);
    await mkdir(store, { recursive: true });
    await Bun.write(join(store, ".credentials.json"), JSON.stringify({ limit: entry.limit }));
    list.push({ id: entry.id, provider: "claude", store });
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

describe.skipIf(!dockerAvailable)("runQa end to end with the fake agent", () => {
  beforeAll(async () => {
    await mkdir(root);
    await cp(join(import.meta.dir, "..", "eval", "ledger"), target, { recursive: true, filter: (source) => basename(source) !== "node_modules" });
    const feature = join(target, ".devcontainer", "probe-feature");
    await mkdir(feature);
    await Bun.write(join(feature, "devcontainer-feature.json"), JSON.stringify({ id: "probe-feature", version: "1.0.0", name: "Probe feature" }));
    await Bun.write(join(feature, "install.sh"), "#!/bin/sh\nset -e\n");
    const devcontainerFile = join(target, ".devcontainer", "devcontainer.json");
    await Bun.write(devcontainerFile, JSON.stringify({ ...(await Bun.file(devcontainerFile).json()), features: { "./probe-feature": {} } }));
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
RUN rm /usr/local/bin/claude-agent-acp \\
 && printf '#!/bin/sh\\nexec node /opt/qa-fake/fake-agent.mjs "$@"\\n' > /usr/local/bin/claude-agent-acp \\
 && chmod 755 /usr/local/bin/claude-agent-acp
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
    "two interns report one defect, the judge groups it, and a confirmation reproduces it",
    async () => {
      const lines: string[] = [];
      const runDir = await runQa({
        dir: target,
        rev: "HEAD",
        interns: 2,
        minutes: 0.5,
        confirmMinutes: 0.5,
        loginsFile: await logins("pair", [
          { id: "claude-1", limit: false },
          { id: "claude-2", limit: false },
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

      const report = await Bun.file(join(runDir, "findings.json")).json();
      expect(report.groups).toHaveLength(1);
      expect(report.groups[0]).toMatchObject({
        id: "g1",
        confirmed: true,
        reproductions: ["i1", "i2", "c1"],
        confirmation: { intern: "c1", provider: "claude", result: { reproduced: true, observed: "fake reproduction", evidence: [] }, error: null },
      });
      expect(report.groups[0].findings.map((finding: { id: string }) => finding.id)).toEqual(["i1/fake-home", "i2/fake-home"]);
      expect(report.groups[0].findings[0]).toMatchObject({
        title,
        evidence: ["interns/i1/out/evidence/page.html"],
        environment: { commit: state.target.commit, environment: `qa-${state.runId}-i1`, provider: "claude", model: "fake-model-1" },
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
    "an intern at a usage limit moves to another login and restarts its charter",
    async () => {
      const lines: string[] = [];
      const runDir = await runQa({
        dir: target,
        rev: "HEAD",
        interns: 1,
        minutes: 0.5,
        confirmMinutes: 0.5,
        loginsFile: await logins("limit", [
          { id: "claude-limited", limit: true },
          { id: "claude-spare", limit: false },
        ]),
        runnerImage: async () => fakeImage,
        print: (line) => lines.push(line),
      });

      expect(lines).toContain("i1 starting on claude-limited (claude)");
      expect(lines).toContain("i1 starting on claude-spare (claude)");
      const state = await readState(runDir);
      expect(state.phase).toBe("done");
      const moved = intern(state, "i1");
      expect(moved).toMatchObject({ login: "claude-spare", status: "done", findings: 1 });
      expect(moved.detail).toStartWith("moved from claude-limited to claude-spare after a login failure (-32603: ");
      expect(intern(state, "c1")).toMatchObject({ login: "claude-spare", status: "done", detail: "reproduced" });

      const transcript = (await Bun.file(join(runDir, "interns", "i1", "transcript.jsonl")).text())
        .split("\n")
        .filter((line) => line !== "")
        .map((line) => JSON.parse(line));
      const prompts = transcript.filter((line) => line.from === "client" && line.message.method === "session/prompt");
      expect(prompts.filter((line) => JSON.stringify(line.message.params).includes("Charter: "))).toHaveLength(2);
      expect(transcript.some((line) => line.from === "agent" && line.message.error?.data?.errorKind === "rate_limit")).toBe(true);

      const report = await Bun.file(join(runDir, "findings.json")).json();
      expect(report.groups).toHaveLength(1);
      expect(report.groups[0]).toMatchObject({ confirmed: true, reproductions: ["i1", "c1"] });

      expect(await leftovers(state.runId)).toEqual([]);
      expect(await workspaces(runDir, state)).toEqual([]);
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
      const loginsFile = await logins("hostile", [{ id: "claude-1", limit: false }]);

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
    },
    timeout,
  );
});
