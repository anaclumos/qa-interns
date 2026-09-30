import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatStatus, newRunId, processStart, readState, resolveRunDir, runDirFor, runsDir, writeState } from "../src/state.ts";
import type { InternState, RunState } from "../src/types.ts";

let home: string;
const previous = process.env.XDG_STATE_HOME;

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), "qa-interns-state-"));
  process.env.XDG_STATE_HOME = home;
});

afterAll(async () => {
  if (previous === undefined) delete process.env.XDG_STATE_HOME;
  else process.env.XDG_STATE_HOME = previous;
  await rm(home, { recursive: true });
});

function intern(overrides: Partial<InternState>): InternState {
  return {
    id: "i1",
    role: "intern",
    charter: "First-time user: sign-up, onboarding, empty states, first actions.",
    group: null,
    provider: "claude",
    login: "claude-1",
    model: "claude-opus-4-1",
    project: "qa-3f9a1c2e-i1",
    status: "testing",
    detail: null,
    findings: 0,
    rejected: 0,
    startedAt: "2026-09-26T09:12:04.511Z",
    endedAt: null,
    ...overrides,
  };
}

function runState(runId: string, startedAt: string): RunState {
  return {
    runId,
    pid: 48213,
    pidStart: 8312765,
    target: { repo: "/home/qa/src/ledger", path: "apps/web", commit: "8d2f1c07b9e4a3f6d5c2b1a0e9f8d7c6b5a4f3e2", dirty: false },
    options: { interns: 3, minutes: 30, confirmMinutes: 10, concurrency: 3 },
    phase: "testing",
    error: null,
    startedAt,
    updatedAt: startedAt,
    endedAt: null,
    interns: [
      intern({ id: "i1", findings: 2 }),
      intern({
        id: "i2",
        provider: "codex",
        login: "codex-pool",
        model: null,
        project: "qa-3f9a1c2e-i2",
        status: "done",
        detail: "Stopped at minute 12: I tested the invoice list.\nNothing else to report.",
        findings: 1,
        rejected: 1,
        endedAt: "2026-09-26T09:24:40.002Z",
      }),
      intern({ id: "i3", provider: null, login: null, model: null, project: null, status: "limited", detail: "No login has spare capacity", startedAt: null }),
    ],
  };
}

async function saveRun(runId: string, startedAt: string): Promise<string> {
  const dir = runDirFor(runId);
  await mkdir(dir, { recursive: true });
  await writeState(dir, runState(runId, startedAt));
  return dir;
}

describe("run ids and directories", () => {
  test("a run id is 8 lowercase hex characters and ids differ", () => {
    const ids = Array.from({ length: 200 }, () => newRunId());
    for (const id of ids) {
      expect(id.length).toBe(8);
      expect([...id].every((character) => "0123456789abcdef".includes(character))).toBe(true);
    }
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("runs live under XDG_STATE_HOME", () => {
    expect(runsDir()).toBe(join(home, "qa-interns", "runs"));
    expect(runDirFor("3f9a1c2e")).toBe(join(home, "qa-interns", "runs", "3f9a1c2e"));
  });
});

describe("state file", () => {
  test("writeState and readState round-trip and leave no temp file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "qa-interns-run-"));
    const state = runState("3f9a1c2e", "2026-09-26T09:10:00.000Z");
    await writeState(dir, state);
    expect(await readState(dir)).toEqual(state);
    const next = { ...state, phase: "failed" as const, error: "Docker is not running", endedAt: "2026-09-26T09:40:00.000Z" };
    await writeState(dir, next);
    expect(await readState(dir)).toEqual(next);
    expect(await readdir(dir)).toEqual(["state.json"]);
    await rm(dir, { recursive: true });
  });

  test("concurrent writes land in call order", async () => {
    const dir = await mkdtemp(join(tmpdir(), "qa-interns-run-"));
    const states = Array.from({ length: 20 }, (_, index) => ({ ...runState("3f9a1c2e", "2026-09-26T09:10:00.000Z"), options: { interns: index + 1, minutes: 30, confirmMinutes: 10, concurrency: 3 } }));
    await Promise.all(states.map((state) => writeState(dir, state)));
    expect((await readState(dir)).options.interns).toBe(20);
    await rm(dir, { recursive: true });
  });

  test("readState names the file when the shape is wrong", async () => {
    const dir = await mkdtemp(join(tmpdir(), "qa-interns-run-"));
    const file = join(dir, "state.json");
    const broken = { ...runState("3f9a1c2e", "2026-09-26T09:10:00.000Z"), phase: "running" };
    await Bun.write(file, JSON.stringify(broken));
    await expect(readState(dir)).rejects.toThrow(`${file} is invalid:\n✖ Invalid option: expected one of`);
    await Bun.write(file, JSON.stringify({ ...broken, phase: "testing", interns: [{ ...intern({}), findings: "2" }] }));
    await expect(readState(dir)).rejects.toThrow(`${file} is invalid:\n✖ Invalid input: expected number, received string\n  → at interns[0].findings`);
    await Bun.write(file, "{\"runId\": \"3f9a1c2e\",");
    await expect(readState(dir)).rejects.toThrow(`${file} is not valid JSON`);
    await rm(file);
    await expect(readState(dir)).rejects.toThrow(`No run state at ${file}`);
    await rm(dir, { recursive: true });
  });
});

describe("resolveRunDir", () => {
  test("throws when there are no runs", async () => {
    await expect(resolveRunDir(undefined)).rejects.toThrow(`No runs in ${join(home, "qa-interns", "runs")}`);
  });

  test("picks the latest run by startedAt, a run id, or a path", async () => {
    const newer = await saveRun("0a1b2c3d", "2026-09-26T11:00:00.000Z");
    const older = await saveRun("ffee0011", "2026-09-26T09:00:00.000Z");
    expect(await resolveRunDir(undefined)).toBe(newer);
    expect(await resolveRunDir("ffee0011")).toBe(older);
    expect(await resolveRunDir(`${older}/`)).toBe(older);
    await expect(resolveRunDir("deadbeef")).rejects.toThrow(`No run deadbeef in ${runsDir()}`);
    await expect(resolveRunDir(join(home, "elsewhere"))).rejects.toThrow(`No run state at ${join(home, "elsewhere", "state.json")}`);
  });
});

describe("processStart", () => {
  test("reads field 22 after the last parenthesis, stays stable, and fails once the process is gone", async () => {
    const sleep = Bun.which("sleep");
    if (sleep === null) throw new Error("sleep is not on PATH");
    const renamed = join(home, "sleep) 1 (2");
    await symlink(sleep, renamed);
    const odd = Bun.spawn([renamed, "30"]);
    const plain = Bun.spawn([sleep, "30"]);
    try {
      const start = processStart(odd.pid);
      expect(processStart(odd.pid)).toBe(start);
      expect(start).toBeGreaterThanOrEqual(processStart(process.pid));
      expect(start).toBeLessThanOrEqual(processStart(plain.pid));
    } finally {
      odd.kill();
      plain.kill();
      await Promise.all([odd.exited, plain.exited]);
    }
    expect(() => processStart(odd.pid)).toThrow("ENOENT");
  });
});

describe("formatStatus", () => {
  test("prints the run header and one aligned line per intern", () => {
    const state = runState("3f9a1c2e", "2026-09-26T09:10:00.000Z");
    const lines = formatStatus(state).split("\n");
    expect(lines.slice(0, 4)).toEqual([
      "Run     3f9a1c2e",
      "Target  /home/qa/src/ledger/apps/web",
      "Commit  8d2f1c07b9e4a3f6d5c2b1a0e9f8d7c6b5a4f3e2",
      "Phase   testing",
    ]);
    expect(lines[4]).toBe("");
    const table = lines.slice(5);
    expect(table).toEqual([
      "Intern  Role    Provider  Status   Findings  Detail",
      "i1      intern  claude    testing  2",
      "i2      intern  codex     done     1         Stopped at minute 12: I tested the invoice list. Nothing else to report.",
      "i3      intern  -         limited  0         No login has spare capacity",
    ]);
  });

  test("names the uncommitted changes of a dirty run after the commit", () => {
    const base = runState("3f9a1c2e", "2026-09-26T09:10:00.000Z");
    const state = { ...base, target: { ...base.target, dirty: true } };
    expect(formatStatus(state).split("\n")[2]).toBe("Commit  8d2f1c07b9e4a3f6d5c2b1a0e9f8d7c6b5a4f3e2 with uncommitted changes");
  });

  test("prints the error when the run failed", () => {
    const state = { ...runState("3f9a1c2e", "2026-09-26T09:10:00.000Z"), phase: "failed" as const, error: "No login has spare capacity" };
    expect(formatStatus(state).split("\n").slice(3, 5)).toEqual(["Phase   failed", "Error   No login has spare capacity"]);
  });
});
