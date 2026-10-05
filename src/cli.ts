#!/usr/bin/env bun
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { z } from "zod";
import { doctor } from "./doctor.ts";
import { imageBuilders, removeCopies, stopRun, sweepImages } from "./environment.ts";
import { errorCode, message, stripControl } from "./findings.ts";
import { defaultLoginsPath } from "./logins.ts";
import { prune } from "./prune.ts";
import { readReplay } from "./report.ts";
import { runQa, startCopy } from "./run.ts";
import { ensureRunnerImage, runnerImage } from "./runner.ts";
import { formatStatus, readState, resolveRunDir, running, writeState } from "./state.ts";
import { exportTree, loadTarget, resolveTarget } from "./target.ts";

const usage = `Usage: qa-interns <command> [options]

Commands:
  doctor [--logins <file>]
      Check Docker, Compose, the isolated network mode, the Dev Container CLI,
      the runner image and its agents, and the logins.
  validate <target-dir> [--commit <rev> | --dirty]
      Check the target's dev container and Compose files at the commit (default
      HEAD), or with --dirty in a copy of its working tree, as run does before it
      builds images, with no logins and no values for hostEnv variables that no
      checked setting depends on.
  run <target-dir> [--commit <rev> | --dirty] [--interns <n>] [--minutes <n>] [--confirm-minutes <n>] [--logins <file>] [--on-end <command>]
      Run interns against the target at the commit, or with --dirty against a
      copy of its working tree: the tracked files as they are and the untracked
      files that Git does not ignore. Defaults: HEAD, 4 interns, 30 minutes
      each, 10 minutes per confirmation. The testing interns run at once, then
      one confirming intern per group of findings, all at once, as far as login
      capacity and free network slots allow. Prints the run directory first.
      With --on-end, run the shell command when the run ends, done, failed, or
      interrupted, with QA_INTERNS_RUN_DIR and QA_INTERNS_PHASE set.
  replay <run> [--commit <rev>] [--group <id>]... [--confirm-minutes <n>] [--logins <file>]
      Hand each confirmed group of the earlier run, or each group --group names,
      to a confirming intern against the run's target at the commit. Defaults:
      HEAD, 10 minutes per confirmation. Prints the run directory first.
  up <target-dir> [--commit <rev>]
      Start one environment of the target at the commit (default HEAD) with no
      interns, run its ready check and seed, and leave it running. Prints the run
      directory first. down removes the environment.
  status [<run>]
      Print the phase and every intern's status.
  report [<run>]
      Print report.md.
  down [<run>]
      Stop the run's orchestrator with SIGTERM when it is still running, then
      tear down every environment the run still has and delete its leftover
      workspace copies.
  prune
      Delete the directory of each run whose job has shipped: its orchestrator
      ended, its state.json has not changed for 24 hours, it ran without
      --dirty, its teardown left nothing, and a merged or closed pull request
      and no open one hold its commit, or each parent of a merge commit that no
      pull request holds. Needs the GitHub CLI, signed in.
  help
      Print this help.

<run> is a run id or a run directory. Without it, the command uses the most recent run.
The default logins file is ${defaultLoginsPath}.
`;

function print(line: string): void {
  process.stdout.write(`${line}\n`);
}

const countSchema = z.coerce.number({ error: "must be a whole number of at least 1" }).int().min(1);
const minutesSchema = z.coerce.number({ error: "must be a number of minutes above 0" }).positive();

function numberOption(schema: z.ZodType<number>, value: string, option: string): number {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new Error(`--${option} ${parsed.error.issues[0]?.message}, got ${value}`);
  return parsed.data;
}

function runArg(command: string, args: string[]): string | undefined {
  const { positionals } = parseArgs({ args, options: {}, allowPositionals: true });
  if (positionals.length > 1) throw new Error(`${command} takes at most one run id or run directory, got ${positionals.join(" ")}`);
  return positionals[0];
}

async function main(args: string[]): Promise<number> {
  const [command, ...rest] = args;
  switch (command) {
    case "doctor": {
      const { values } = parseArgs({ args: rest, options: { logins: { type: "string", default: defaultLoginsPath } } });
      return (await doctor(values.logins, print)) ? 0 : 1;
    }
    case "validate": {
      const { values, positionals } = parseArgs({ args: rest, allowPositionals: true, options: { commit: { type: "string" }, dirty: { type: "boolean", default: false } } });
      const [dir, ...extra] = positionals;
      if (dir === undefined || extra.length > 0) throw new Error("validate takes exactly one target directory. Run qa-interns help for usage.");
      if (values.dirty && values.commit !== undefined) throw new Error("--dirty checks the working tree, so it takes no --commit");
      const ref = await resolveTarget(dir, values.commit ?? "HEAD", values.dirty);
      const source = await mkdtemp(join(tmpdir(), "qa-interns-validate-"));
      try {
        await exportTree(ref, source);
        const target = await loadTarget(ref, source, true);
        imageBuilders(target);
        print(`${join(ref.repo, ref.path)} at ${ref.commit}${ref.dirty ? " with uncommitted changes" : ""} passes the checks that run makes before it builds images.`);
        const unset = target.settings.hostEnv.filter((name) => process.env[name] === undefined);
        if (unset.length > 0) print(`hostEnv names ${unset.join(", ")}, which the environment of qa-interns does not set. No checked setting depends on them.`);
      } finally {
        await rm(source, { recursive: true, force: true });
      }
      return 0;
    }
    case "run": {
      const { values, positionals } = parseArgs({
        args: rest,
        allowPositionals: true,
        options: {
          commit: { type: "string" },
          dirty: { type: "boolean", default: false },
          interns: { type: "string", default: "4" },
          minutes: { type: "string", default: "30" },
          "confirm-minutes": { type: "string", default: "10" },
          logins: { type: "string", default: defaultLoginsPath },
          "on-end": { type: "string" },
        },
      });
      const [dir, ...extra] = positionals;
      if (dir === undefined || extra.length > 0) throw new Error("run takes exactly one target directory. Run qa-interns help for usage.");
      if (values.dirty && values.commit !== undefined) throw new Error("--dirty runs the working tree, so it takes no --commit");
      const options = {
        dir,
        rev: values.commit ?? "HEAD",
        dirty: values.dirty,
        interns: numberOption(countSchema, values.interns, "interns"),
        minutes: numberOption(minutesSchema, values.minutes, "minutes"),
        confirmMinutes: numberOption(minutesSchema, values["confirm-minutes"], "confirm-minutes"),
        loginsFile: values.logins,
        onEnd: values["on-end"],
      };
      await runQa({ ...options, replay: null, runnerImage: ensureRunnerImage, print });
      return 0;
    }
    case "replay": {
      const { values, positionals } = parseArgs({
        args: rest,
        allowPositionals: true,
        options: {
          commit: { type: "string", default: "HEAD" },
          group: { type: "string", multiple: true, default: [] },
          "confirm-minutes": { type: "string", default: "10" },
          logins: { type: "string", default: defaultLoginsPath },
        },
      });
      const [run, ...extra] = positionals;
      if (run === undefined || extra.length > 0) throw new Error("replay takes exactly one run id or run directory. Run qa-interns help for usage.");
      const confirmMinutes = numberOption(minutesSchema, values["confirm-minutes"], "confirm-minutes");
      const replay = await readReplay(await resolveRunDir(run), values.group);
      await runQa({
        dir: join(replay.target.repo, replay.target.path),
        rev: values.commit,
        dirty: false,
        interns: 0,
        minutes: 0,
        confirmMinutes,
        loginsFile: values.logins,
        replay,
        runnerImage: ensureRunnerImage,
        print,
      });
      return 0;
    }
    case "up": {
      const { values, positionals } = parseArgs({ args: rest, allowPositionals: true, options: { commit: { type: "string", default: "HEAD" } } });
      const [dir, ...extra] = positionals;
      if (dir === undefined || extra.length > 0) throw new Error("up takes exactly one target directory. Run qa-interns help for usage.");
      await startCopy({ dir, rev: values.commit, runnerImage: ensureRunnerImage, print });
      return 0;
    }
    case "status": {
      print(formatStatus(await readState(await resolveRunDir(runArg(command, rest)))));
      return 0;
    }
    case "report": {
      const dir = await resolveRunDir(runArg(command, rest));
      const report = Bun.file(join(dir, "report.md"));
      if (!(await report.exists())) {
        const state = await readState(dir);
        throw new Error(`Run ${state.runId} has no report yet. Its phase is ${state.phase}.`);
      }
      process.stdout.write(await report.text());
      return 0;
    }
    case "down": {
      const dir = await resolveRunDir(runArg(command, rest));
      const state = await readState(dir);
      if (running(state.pid, state.pidStart)) {
        try {
          process.kill(state.pid, "SIGTERM");
          print(`Sent SIGTERM to run ${state.runId} (process ${state.pid}).`);
        } catch (error) {
          if (errorCode(error) !== "ESRCH") throw error;
        }
        const deadline = Date.now() + 120_000;
        while (running(state.pid, state.pidStart) && Date.now() < deadline) await Bun.sleep(500);
        if (running(state.pid, state.pidStart)) {
          throw new Error(
            `Process ${state.pid} of run ${state.runId} is still running after 120 seconds, so its environments were left alone. Stop it with kill -9 ${state.pid}, then run down again.`,
          );
        }
        print(`Process ${state.pid} exited.`);
      }
      await stopRun(dir, state.runId);
      await removeCopies(dir, state.runId, await runnerImage());
      try {
        await sweepImages();
      } catch (error) {
        print(message(error));
      }
      const after = await readState(dir);
      if (after.phase === "up") {
        const ended = new Date().toISOString();
        await writeState(dir, { ...after, phase: "done", updatedAt: ended, endedAt: ended });
      }
      print(`Run ${state.runId} has no environments left.`);
      return 0;
    }
    case "prune": {
      parseArgs({ args: rest, options: {} });
      await prune(print);
      return 0;
    }
    case "help":
    case "--help":
    case "-h":
      process.stdout.write(usage);
      return 0;
    case undefined:
      process.stderr.write(usage);
      return 1;
    default:
      throw new Error(`Unknown command ${command}. Run qa-interns help for usage.`);
  }
}

try {
  process.exitCode = await main(Bun.argv.slice(2));
} catch (error) {
  process.stderr.write(`qa-interns: ${stripControl(message(error))}\n`);
  process.exitCode = 1;
}
