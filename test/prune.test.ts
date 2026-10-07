import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { closeSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readdir, rm, symlink, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { flock } from "../src/logins.ts";
import { replayLock } from "../src/report.ts";
import { processStart, runDirFor, writeState } from "../src/state.ts";
import { capture, execute } from "../src/target.ts";
import type { RunState } from "../src/types.ts";

const dockerAvailable = Bun.spawnSync(["docker", "info"], { stdout: "ignore", stderr: "ignore" }).exitCode === 0;
const cliScript = join(import.meta.dir, "..", "src", "cli.ts");

const fakeGh = `
import { existsSync, renameSync } from "node:fs";
const finish = process.env.FAKE_GH_FINISH;
if (finish !== undefined && existsSync(finish + ".next")) renameSync(finish + ".next", finish);
const pulls = JSON.parse(await Bun.file(process.env.FAKE_GH_PULLS).text());
const [command, kind, ...rest] = process.argv.slice(2);
if (command !== "api" || kind !== "graphql") throw new Error("unexpected gh " + process.argv.slice(2).join(" "));
const data = {};
for (let index = 0; index < rest.length; index += 2) {
  if (rest[index] !== "-f") throw new Error("unexpected gh argument " + rest[index]);
  const field = rest[index + 1];
  const name = field.slice(0, field.indexOf("="));
  const value = field.slice(field.indexOf("=") + 1);
  if (name === "query") continue;
  if (!value.endsWith(" is:pr")) throw new Error("unexpected search " + value);
  data[name] = pulls[value.slice(0, -" is:pr".length)] ?? { issueCount: 0, nodes: [] };
}
process.stdout.write(JSON.stringify({ data }));
`;

let home: string;
const previous = process.env.XDG_STATE_HOME;

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), "qa-interns-prune-"));
  const bin = join(home, "bin");
  await mkdir(bin);
  await Bun.write(join(home, "fake-gh.mjs"), fakeGh);
  await Bun.write(join(bin, "gh"), `#!/bin/sh\nexec "${process.execPath}" "${join(home, "fake-gh.mjs")}" "$@"\n`);
  await chmod(join(bin, "gh"), 0o755);
  process.env.XDG_STATE_HOME = join(home, "state");
});

afterAll(async () => {
  if (previous === undefined) delete process.env.XDG_STATE_HOME;
  else process.env.XDG_STATE_HOME = previous;
  await rm(home, { recursive: true });
});

function sha(): string {
  return randomBytes(20).toString("hex");
}

function pulls(...states: string[]) {
  return { issueCount: states.length, nodes: states.map((state) => ({ state })) };
}

async function saveRun(runId: string, target: { repo: string; commit: string; dirty?: boolean }, overrides: Partial<RunState> = {}): Promise<string> {
  const dir = runDirFor(runId);
  await mkdir(join(dir, "interns", "i1", "out"), { recursive: true });
  await Bun.write(join(dir, "report.md"), "# QA Interns report\n");
  const ended = "2026-09-26T09:40:00.000Z";
  await writeState(dir, {
    runId,
    pid: 48213,
    pidStart: 8312765,
    target: { repo: target.repo, path: "", commit: target.commit, dirty: target.dirty ?? false },
    options: { interns: 1, minutes: 30, confirmMinutes: 10, concurrency: 1, confirmConcurrency: 0 },
    phase: "done",
    error: null,
    startedAt: "2026-09-26T09:00:00.000Z",
    updatedAt: ended,
    endedAt: ended,
    interns: [],
    ...overrides,
  });
  return dir;
}

async function replays(runId: string, source: string, commit: string, file = "findings.json"): Promise<void> {
  const run = { runId, replay: { runId: source, commit, dirty: false }, phase: "done", reproducedGroups: 1, notReproducedGroups: 0, uncheckedGroups: 0 };
  await Bun.write(join(runDirFor(runId), file), JSON.stringify({ run, groups: [], interns: [], egress: [], environments: [] }));
}

describe.skipIf(!dockerAvailable)("prune", () => {
  test("deletes the run directories of shipped jobs and keeps every other run", async () => {
    const repo = join(home, "repo");
    await mkdir(repo);
    const git = ["git", "-C", repo, "-c", "user.name=QA Interns", "-c", "user.email=qa@example.test", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null"];
    await execute([...git, "init", "-q"]);
    await execute([...git, "commit", "-q", "--allow-empty", "-m", "Base"]);
    const base = (await execute([...git, "rev-parse", "HEAD"])).trim();
    const tree = `${base}^{tree}`;
    const commit = async (message: string, ...parents: string[]) => (await execute([...git, "commit-tree", ...parents.flatMap((parent) => ["-p", parent]), "-m", message, tree])).trim();
    const merged = await commit("Merged head", base);
    const closed = await commit("Closed head", base);
    const open = await commit("Open head", base);
    const unpushed = await commit("Unpushed", base);
    const firstBatch = await commit("qa batch", base, merged);
    const shippedBatch = await commit("qa batch", firstBatch, closed);
    const openBatch = await commit("qa batch", base, open);

    const squashed = sha();
    const reopened = sha();
    const crowded = sha();
    await Bun.write(
      join(home, "pulls.json"),
      JSON.stringify({
        [base]: pulls("MERGED"),
        [merged]: pulls("MERGED"),
        [closed]: pulls("CLOSED"),
        [open]: pulls("OPEN"),
        [squashed]: pulls("MERGED"),
        [reopened]: pulls("CLOSED", "OPEN"),
        [crowded]: { issueCount: 101, nodes: pulls(...Array<string>(100).fill("MERGED")).nodes },
      }),
    );

    const gone = join(home, "removed-worktree");
    const now = new Date().toISOString();
    const abandoned = runDirFor("a0000012");
    await mkdir(abandoned, { recursive: true });
    await Bun.write(join(abandoned, `state.json.${process.pid}.tmp`), "");
    const twoDaysAgo = new Date(Date.now() - 48 * 60 * 60_000);
    await utimes(abandoned, twoDaysAgo, twoDaysAgo);
    const shipped = [await saveRun("a0000001", { repo: gone, commit: squashed }), await saveRun("a0000002", { repo, commit: shippedBatch }), abandoned];
    await replays("a0000002", "a0000001", shippedBatch);
    const leftover = await saveRun("a0000009", { repo: gone, commit: squashed });
    await mkdir(join(leftover, "envs", "i1", "qa-a0000009-i1"), { recursive: true });
    const starting = runDirFor("a0000013");
    await mkdir(starting);
    const kept = [
      await saveRun("a0000011", { repo: gone, commit: squashed }),
      starting,
      await saveRun("a0000003", { repo: gone, commit: reopened }),
      await saveRun("a0000004", { repo, commit: openBatch }),
      await saveRun("a0000005", { repo, commit: unpushed }),
      await saveRun("a0000006", { repo: gone, commit: crowded }),
      await saveRun("a0000007", { repo: gone, commit: squashed, dirty: true }),
      await saveRun("a0000008", { repo: gone, commit: squashed }, { updatedAt: now, endedAt: now }),
      await saveRun("a0000010", { repo: gone, commit: squashed }, { pid: process.pid, pidStart: processStart(process.pid), phase: "testing", endedAt: null }),
      leftover,
    ];
    await replays("a0000003", "a0000011", reopened);
    const replayed = await saveRun("a0000014", { repo: gone, commit: squashed });
    kept.push(replayed);
    const finishing = await saveRun("a0000016", { repo: gone, commit: squashed }, { pid: process.pid, pidStart: processStart(process.pid), phase: "confirming", endedAt: null });
    kept.push(finishing, await saveRun("a0000017", { repo: gone, commit: squashed }));
    await replays("a0000016", "a0000017", squashed, "findings.json.next");
    const outside = join(home, "outside");
    await mkdir(outside);
    await Bun.write(join(outside, "notes.txt"), "kept\n");
    await utimes(outside, twoDaysAgo, twoDaysAgo);
    const linked = join(home, "state", "qa-interns", "runs", "a0000015");
    await symlink(outside, linked);
    kept.push(linked);

    const env = {
      ...process.env,
      PATH: `${join(home, "bin")}:${process.env.PATH}`,
      FAKE_GH_PULLS: join(home, "pulls.json"),
      FAKE_GH_FINISH: join(finishing, "findings.json"),
    };
    const lock = flock(replayLock(replayed), "shared", "block");
    if (lock === null) throw new Error(`flock on ${replayLock(replayed)} returned no lock`);
    const pruned = await capture(["bun", cliScript, "prune"], { env }).finally(() => closeSync(lock));
    expect(pruned.stderr).toBe("");
    expect(pruned.code).toBe(0);

    const lines = pruned.stdout.trimEnd().split("\n");
    expect((await readdir(join(home, "state", "qa-interns", "runs"))).sort()).toEqual(kept.map((dir) => dir.slice(-8)).sort());
    expect(await readdir(outside)).toEqual(["notes.txt"]);
    expect(lines.slice(0, -1).sort()).toEqual(shipped.map((dir) => `Removed run ${dir.slice(-8)}.`));
    expect(lines.at(-1)).toBe(
      "Removed 3 of 16 run directories. Kept 4 running or changed within 24 hours, 1 run with --dirty, 1 with teardown leftovers that qa-interns down removes, 4 whose job has not shipped, and 3 whose findings a kept run replays.",
    );
  });
});
