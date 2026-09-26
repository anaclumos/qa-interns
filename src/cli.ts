#!/usr/bin/env bun
import { join } from "node:path";
import { parseArgs } from "node:util";
import { doctor } from "./doctor.ts";
import { removeCopies, stopRun } from "./environment.ts";
import { errorCode, stripControl } from "./findings.ts";
import { defaultLoginsPath } from "./logins.ts";
import { runQa } from "./run.ts";
import { ensureRunnerImage, runnerImage } from "./runner.ts";
import { formatStatus, processStart, readState, resolveRunDir } from "./state.ts";

const usage = `Usage: qa-interns <command> [options]

Commands:
  doctor [--logins <file>]
      Check Docker, Compose, the isolated network mode, the Dev Container CLI,
      the runner image and its agents, the logins, and free memory.
  run <target-dir> [--commit <rev>] [--interns <n>] [--minutes <n>] [--confirm-minutes <n>] [--logins <file>]
      Run interns against the target at the commit. Defaults: HEAD, 4 interns,
      30 minutes each, 10 minutes per confirmation. Prints the run directory first.
  status [<run>]
      Print the phase and every intern's status.
  report [<run>]
      Print report.md.
  down [<run>]
      Stop the run's orchestrator with SIGTERM when it is still running, then
      tear down every environment the run still has and delete its leftover
      workspace copies.
  help
      Print this help.

<run> is a run id or a run directory. Without it, the command uses the most recent run.
The default logins file is ${defaultLoginsPath}.
`;

function print(line: string): void {
  process.stdout.write(`${line}\n`);
}

function count(value: string, option: string): number {
  const number = Number(value);
  if (value.trim() === "" || !Number.isSafeInteger(number) || number < 1) throw new Error(`--${option} must be a whole number of at least 1, got ${value}`);
  return number;
}

function minutes(value: string, option: string): number {
  const number = Number(value);
  if (value.trim() === "" || !Number.isFinite(number) || number <= 0) throw new Error(`--${option} must be a number of minutes above 0, got ${value}`);
  return number;
}

function running(pid: number, start: number): boolean {
  try {
    return processStart(pid) === start;
  } catch (error) {
    if (errorCode(error) === "ENOENT" || errorCode(error) === "ESRCH") return false;
    throw error;
  }
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
    case "run": {
      const { values, positionals } = parseArgs({
        args: rest,
        allowPositionals: true,
        options: {
          commit: { type: "string", default: "HEAD" },
          interns: { type: "string", default: "4" },
          minutes: { type: "string", default: "30" },
          "confirm-minutes": { type: "string", default: "10" },
          logins: { type: "string", default: defaultLoginsPath },
        },
      });
      const [dir, ...extra] = positionals;
      if (dir === undefined || extra.length > 0) throw new Error("run takes exactly one target directory. Run qa-interns help for usage.");
      const options = {
        dir,
        rev: values.commit,
        interns: count(values.interns, "interns"),
        minutes: minutes(values.minutes, "minutes"),
        confirmMinutes: minutes(values["confirm-minutes"], "confirm-minutes"),
        loginsFile: values.logins,
      };
      await runQa({ ...options, runnerImage: ensureRunnerImage, print });
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
      if (state.phase !== "done" && state.phase !== "failed" && running(state.pid, state.pidStart)) {
        try {
          process.kill(state.pid, "SIGTERM");
          print(`Sent SIGTERM to run ${state.runId} (process ${state.pid}).`);
        } catch (error) {
          if (errorCode(error) !== "ESRCH") throw error;
        }
        const deadline = Date.now() + 120_000;
        while (running(state.pid, state.pidStart) && Date.now() < deadline) await Bun.sleep(500);
        print(running(state.pid, state.pidStart) ? `Process ${state.pid} is still running after 120 seconds.` : `Process ${state.pid} exited.`);
      }
      await stopRun(state.runId);
      await removeCopies(dir, state.runId, await runnerImage());
      print(`Run ${state.runId} has no environments left.`);
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
  process.stderr.write(`qa-interns: ${stripControl(error instanceof Error ? error.message : String(error))}\n`);
  process.exitCode = 1;
}
