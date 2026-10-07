import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { cp, mkdir, readdir } from "node:fs/promises";
import { basename, join } from "node:path";
import { errorCode } from "../src/findings.ts";
import { newRunId, readState, writeState } from "../src/state.ts";
import { capture, execute } from "../src/target.ts";
import { cliScript, dockerAvailable, endToEnd, intern, leftovers, timeout, title } from "./e2e.ts";

describe.skipIf(!dockerAvailable)("end to end with the fake agent", () => {
  const { root, target, fakeImage, logins } = endToEnd();

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
          await logins("interrupt"),
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
    "a run that SIGTERM interrupts during its teardown finishes the teardown and records the interrupt",
    async () => {
      const ended = join(root, "teardown-ended.txt");
      const cli = Bun.spawn(
        [
          process.execPath,
          cliScript,
          "run",
          target,
          "--interns",
          "1",
          "--logins",
          await logins("teardown-interrupt"),
          "--on-end",
          `printf '%s\\n' "$QA_INTERNS_PHASE" > '${ended}'`,
        ],
        { env: { ...process.env }, stdin: "ignore", stdout: "pipe", stderr: "pipe" },
      );
      const reader = cli.stdout.getReader();
      const decoder = new TextDecoder();
      let out = "";
      while (!out.includes("i1 limited:")) {
        const chunk = await reader.read();
        if (chunk.done) throw new Error(`run exited before its teardown: ${out}${await new Response(cli.stderr).text()}`);
        out += decoder.decode(chunk.value, { stream: true });
      }
      cli.kill("SIGTERM");
      const [code, stderr] = await Promise.all([cli.exited, new Response(cli.stderr).text()]);

      expect(code).toBe(130);
      expect(stderr).toContain("Interrupted. Closing sessions and tearing down.\n");
      expect(await Bun.file(ended).text()).toBe("failed\n");
      const state = await readState(out.slice(0, out.indexOf("\n")));
      expect(state).toMatchObject({ phase: "failed" });
      expect(state.error).toStartWith("interrupted");
      expect(state.error).not.toContain("teardown failed");
      expect(await leftovers(state.runId)).toEqual([]);
    },
    timeout,
  );

  test(
    "a run that SIGTERM interrupts while an intern tests writes report.md, findings.json, and state.json with the findings of the interns that ended, before its teardown",
    async () => {
      const options = {
        dir: target,
        rev: "HEAD",
        dirty: false,
        interns: 2,
        minutes: 10,
        confirmMinutes: 0.5,
        loginsFile: await logins("snapshot", { hang: "What owners, editors, and viewers can see" }, 2),
        replay: null,
      };
      const module = join(import.meta.dir, "..", "src", "run.ts");
      const cli = Bun.spawn(
        [
          process.execPath,
          "-e",
          `const { runQa } = await import(${JSON.stringify(module)}); await runQa({ ...${JSON.stringify(options)}, runnerImage: async () => ${JSON.stringify(fakeImage)}, admit: () => () => {}, print: (line) => process.stdout.write(line + "\\n") });`,
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
      const drained = (async () => {
        for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) out += decoder.decode(chunk.value, { stream: true });
      })();
      const errors = new Response(cli.stderr).text();
      const runDir = out.slice(0, out.indexOf("\n"));
      const statuses = async () => (await readState(runDir)).interns.map((entry) => `${entry.status}:${entry.findings}`).sort();
      while (cli.exitCode === null && (await statuses()).join() !== "done:1,testing:0") await Bun.sleep(100);
      if (cli.exitCode !== null) {
        await drained;
        throw new Error(`run exited with ${cli.exitCode} before one intern ended and the other tested:\n${out}${await errors}`);
      }
      cli.kill("SIGTERM");
      const ended = (await readState(runDir)).interns.find((entry) => entry.status === "done")?.id;
      const written = async () => {
        const file = Bun.file(join(runDir, "findings.json"));
        if (!(await file.exists())) return null;
        try {
          return await file.json();
        } catch (error) {
          if (error instanceof SyntaxError) return null;
          throw error;
        }
      };
      let early = null;
      while (cli.exitCode === null && (early = await written()) === null) await Bun.sleep(10);
      const live = await leftovers(basename(runDir));
      const [code] = await Promise.all([cli.exited, drained]);

      expect(early?.run).toMatchObject({ phase: "failed", error: "interrupted" });
      expect(early?.groups.map((group: { findings: { id: string }[] }) => group.findings.map((finding) => finding.id))).toEqual([[`${ended}/fake-home`]]);
      expect(early?.interns.map((entry: { id: string; status: string }) => [entry.id, entry.status])).toEqual(
        ["i1", "i2"].map((entry) => [entry, entry === ended ? "done" : "testing"]),
      );
      expect(live).not.toEqual([]);
      expect(code).toBe(130);
      const state = await readState(runDir);
      expect(state).toMatchObject({ phase: "failed", error: "interrupted" });
      expect(await leftovers(state.runId)).toEqual([]);
    },
    timeout,
  );

  test(
    "down ends a run whose orchestrator ended before it recorded the end of the run or of an intern",
    async () => {
      const started = new Date().toISOString();
      const member = { role: "confirm" as const, charter: title, login: "openrouter-1", model: null, findings: 0, rejected: 0, startedAt: started };
      for (const [phase, error, expected] of [
        ["confirming", null, "The orchestrator process ended in phase confirming"],
        ["failed", "interrupted", "interrupted"],
      ] as const) {
        const runId = newRunId();
        const runDir = join(root, "ended", runId);
        await mkdir(runDir, { recursive: true });
        await writeState(runDir, {
          runId,
          pid: process.pid,
          pidStart: 0,
          target: { repo: join(root, "repo"), path: "eval/ledger", commit: "0".repeat(40), dirty: false },
          options: { interns: 0, minutes: 0, confirmMinutes: 10, concurrency: 0, confirmConcurrency: 3 },
          phase,
          error,
          startedAt: started,
          updatedAt: started,
          endedAt: error === null ? null : started,
          interns: [
            { ...member, id: "c1", group: "g1", project: `qa-${runId}-c1`, status: "done", detail: "reproduced", endedAt: started },
            { ...member, id: "c2", group: "g2", project: `qa-${runId}-c2`, status: "testing", detail: null, endedAt: null },
            { ...member, id: "c3", group: "g3", project: null, status: "queued", detail: null, startedAt: null, endedAt: null },
          ],
        });

        const down = await capture([process.execPath, cliScript, "down", runDir], { env: { ...process.env } });
        expect(down).toMatchObject({ code: 0, stdout: `Run ${runId} has no environments left.\n` });
        const state = await readState(runDir);
        expect(state).toMatchObject({ phase: "failed", error: expected });
        const ended = state.endedAt ?? "";
        expect(Date.parse(ended)).toBeGreaterThanOrEqual(Date.parse(started));
        expect(intern(state, "c1")).toMatchObject({ status: "done", detail: "reproduced", endedAt: started });
        expect(intern(state, "c2")).toMatchObject({ status: "failed", endedAt: state.updatedAt });
        expect(intern(state, "c3")).toMatchObject({ status: "failed", endedAt: state.updatedAt });

        expect(await capture([process.execPath, cliScript, "down", runDir], { env: { ...process.env } })).toMatchObject({ code: 0 });
        expect(await readState(runDir)).toEqual(state);
      }
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
          await logins("down"),
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
