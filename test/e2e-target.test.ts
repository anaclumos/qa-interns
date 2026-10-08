import { describe, expect, test } from "bun:test";
import { cp, mkdir, realpath, symlink } from "node:fs/promises";
import { join } from "node:path";
import { readRelayLogs } from "../src/environment.ts";
import { runQa } from "../src/run.ts";
import { readState } from "../src/state.ts";
import { execute } from "../src/target.ts";
import type { EnvironmentStats } from "../src/types.ts";
import { disks, dockerAvailable, endToEnd, intern, leftovers, timeout, workspaces } from "./e2e.ts";

describe.skipIf(!dockerAvailable)("end to end with the fake agent", () => {
  const { root, target, fakeImage, logins } = endToEnd();

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
        loginsFile: await logins("relayed"),
        replay: null,
        runnerImage: async () => fakeImage,
        admit: () => () => {},
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
      const loginsFile = await logins("hostile");

      const lines: string[] = [];
      const previous = process.env.QA_PROBE_DIR;
      process.env.QA_PROBE_DIR = probe;
      let error: unknown = null;
      try {
        await runQa({ dir: hostile, rev: "HEAD", dirty: false, interns: 1, minutes: 0.5, confirmMinutes: 0.5, loginsFile, replay: null, runnerImage: async () => fakeImage, admit: () => () => {}, print: (line) => lines.push(line) });
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
      expect(environment).toMatchObject({ intern: "i1", readyAt: null });
      expect(environment?.containers?.map((container) => container.service)).toContain("web");

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
      const ended = join(root, "flood-ended.txt");
      const run = runQa({
        dir: target,
        rev: "HEAD",
        dirty: false,
        interns: 1,
        minutes: 5,
        confirmMinutes: 0.5,
        loginsFile: await logins("flood", { flood: true }),
        replay: null,
        onEnd: `printf '%s\\n' "$QA_INTERNS_RUN_DIR" "$QA_INTERNS_PHASE" > '${ended}'; exit 3`,
        runnerImage: async () => fakeImage,
        admit: () => () => {},
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
        loginsFile: await logins("dirty"),
        replay: null,
        runnerImage: async () => fakeImage,
        admit: () => () => {},
        print: (line) => lines.push(line),
      });

      const state = await readState(runDir);
      expect(state).toMatchObject({ phase: "done", error: null, target: { path: "", commit: head, dirty: true } });
      expect(await Bun.file(join(runDir, "interns", "i1", "out", "evidence", "page.html")).text()).toContain('<p id="notice">Uncommitted notice</p>');
      expect(await Bun.file(join(runDir, "source", "node_modules", "ignored.txt")).exists()).toBe(false);
      const report = await Bun.file(join(runDir, "findings.json")).json();
      expect(report.run.target).toEqual(state.target);
      expect(report.groups[0].findings[0].environment).toEqual({ commit: head, dirty: true, environment: `qa-${state.runId}-i1`, model: "vercel-ai-gateway/anthropic/claude-haiku-5.5" });
      expect((await Bun.file(join(runDir, "report.md")).text()).split("\n")).toContain(`- Commit: \`${head}\`, with the uncommitted changes and untracked files of the working tree`);

      expect(await leftovers(state.runId)).toEqual([]);
      expect(await workspaces(runDir, state)).toEqual([]);
      expect(await disks(runDir, state)).toEqual([]);
    },
    timeout,
  );
});
