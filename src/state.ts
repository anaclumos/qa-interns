import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { z } from "zod";
import { oneLine } from "./findings.ts";
import { internStatuses, providerNames, roles, runPhases, type RunState } from "./types.ts";

const stateSchema = z.object({
  runId: z.string().min(1),
  pid: z.int().positive(),
  pidStart: z.int().nonnegative(),
  target: z.object({ repo: z.string(), path: z.string(), commit: z.string(), dirty: z.boolean() }),
  options: z.object({ interns: z.number(), minutes: z.number(), confirmMinutes: z.number(), concurrency: z.number() }),
  phase: z.enum(runPhases),
  error: z.string().nullable(),
  startedAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  endedAt: z.iso.datetime().nullable(),
  interns: z.array(
    z.object({
      id: z.string().min(1),
      role: z.enum(roles),
      charter: z.string(),
      group: z.string().nullable(),
      provider: z.enum(providerNames).nullable(),
      login: z.string().nullable(),
      model: z.string().nullable(),
      project: z.string().nullable(),
      status: z.enum(internStatuses),
      detail: z.string().nullable(),
      findings: z.int().nonnegative(),
      rejected: z.int().nonnegative(),
      startedAt: z.iso.datetime().nullable(),
      endedAt: z.iso.datetime().nullable(),
    }),
  ),
});

export function stateDir(): string {
  return join(process.env.XDG_STATE_HOME || join(homedir(), ".local", "state"), "qa-interns");
}

export function runsDir(): string {
  return join(stateDir(), "runs");
}

export function processStart(pid: number): number {
  const file = `/proc/${pid}/stat`;
  const stat = readFileSync(file, "utf8");
  const start = Number(stat.slice(stat.lastIndexOf(")") + 1).trim().split(" ")[19]);
  if (!Number.isSafeInteger(start)) throw new Error(`${file} has no start time in field 22`);
  return start;
}

export function newRunId(): string {
  return randomBytes(4).toString("hex");
}

export function runDirFor(runId: string): string {
  return join(runsDir(), runId);
}

export async function resolveRunDir(arg: string | undefined): Promise<string> {
  if (arg === undefined) return latestRunDir();
  const dir = arg.includes("/") ? resolve(arg) : runDirFor(arg);
  if (!existsSync(join(dir, "state.json"))) {
    throw new Error(arg.includes("/") ? `No run state at ${join(dir, "state.json")}` : `No run ${arg} in ${runsDir()}`);
  }
  return dir;
}

async function latestRunDir(): Promise<string> {
  const root = runsDir();
  if (!existsSync(root)) throw new Error(`No runs in ${root}`);
  const runs = await Promise.all(
    (await readdir(root)).map(async (name) => {
      const dir = join(root, name);
      return { dir, startedAt: Date.parse((await readState(dir)).startedAt) };
    }),
  );
  runs.sort((a, b) => b.startedAt - a.startedAt);
  const latest = runs[0];
  if (latest === undefined) throw new Error(`No runs in ${root}`);
  return latest.dir;
}

export async function readJson<T>(file: string, schema: z.ZodType<T>, missing = `No file at ${file}`): Promise<T> {
  const handle = Bun.file(file);
  if (!(await handle.exists())) throw new Error(missing);
  let raw: unknown;
  try {
    raw = JSON.parse(await handle.text());
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error(`${file} is not valid JSON: ${error.message}`);
    throw error;
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new Error(`${file} is invalid:\n${z.prettifyError(parsed.error)}`);
  return parsed.data;
}

export async function readState(runDir: string): Promise<RunState> {
  const file = join(runDir, "state.json");
  return readJson(file, stateSchema, `No run state at ${file}`);
}

export async function writeState(runDir: string, state: RunState): Promise<void> {
  const file = join(runDir, "state.json");
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`);
  renameSync(temp, file);
}

export function formatStatus(state: RunState): string {
  const summary = [
    ["Run", state.runId],
    ["Target", join(state.target.repo, state.target.path)],
    ["Commit", state.target.dirty ? `${state.target.commit} with uncommitted changes` : state.target.commit],
    ["Phase", state.phase],
    ...(state.error === null ? [] : [["Error", state.error]]),
  ];
  const interns = [
    ["Intern", "Role", "Provider", "Status", "Findings", "Detail"],
    ...state.interns.map((intern) => [
      intern.id,
      intern.role,
      intern.provider ?? "-",
      intern.status,
      String(intern.findings),
      oneLine(intern.detail ?? ""),
    ]),
  ];
  return [...align(summary), "", ...align(interns)].join("\n");
}

function align(rows: string[][]): string[] {
  const widths = rows.reduce<number[]>((max, row) => row.map((cell, column) => Math.max(max[column] ?? 0, cell.length)), []);
  return rows.map((row) => row.map((cell, column) => cell.padEnd(widths[column] ?? 0)).join("  ").trimEnd());
}
