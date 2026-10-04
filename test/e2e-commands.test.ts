import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { cp, mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import { errorCode } from "../src/findings.ts";
import { timeUpPrompt } from "../src/prompt.ts";
import { readReplay } from "../src/report.ts";
import { runQa } from "../src/run.ts";
import { readState } from "../src/state.ts";
import { capture, execute } from "../src/target.ts";
import type { EnvironmentStats } from "../src/types.ts";
import { cliScript, disks, dockerAvailable, endToEnd, intern, leftovers, timeout, title, workspaces } from "./e2e.ts";

describe.skipIf(!dockerAvailable)("end to end with the fake agent", () => {
  const { root, target, fakeImage, logins } = endToEnd();

  test(
    "a replay hands the confirmed group of an earlier run to a confirming intern at a new commit and reports that it reproduced, also when the intern writes its confirmation only after its time box ends, and sends no prompt after a turn that a cancel does not end",
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

      const lateDir = await runQa({
        dir: join(replay.target.repo, replay.target.path),
        rev: next,
        dirty: false,
        interns: 0,
        minutes: 0,
        confirmMinutes: 0.5,
        loginsFile: await logins("replay-late", [{ id: "claude-late", provider: "claude", late: true }]),
        replay: await readReplay(sourceDir, ["g1"]),
        runnerImage: async () => fakeImage,
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
          replay: await readReplay(sourceDir, ["g1"]),
          runnerImage: async () => fakeImage,
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

      for (const [dir, run] of [
        [sourceDir, source],
        [runDir, state],
        [failedDir, failed],
        [lateDir, late],
        [deafDir, deaf],
      ] as const) {
        expect(await leftovers(run.runId)).toEqual([]);
        expect(await workspaces(dir, run)).toEqual([]);
        expect(await disks(dir, run)).toEqual([]);
      }
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
});
