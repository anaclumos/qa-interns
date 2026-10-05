import { closeSync, existsSync } from "node:fs";
import { readdir, rm, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { z } from "zod";
import { hostObjects, leftBehind } from "./environment.ts";
import { flock } from "./logins.ts";
import { replayLock, storedRunSchema } from "./report.ts";
import { readJson, running, runsDir, stateSchema } from "./state.ts";
import { capture, execute, failure } from "./target.ts";

const settleMs = 24 * 60 * 60_000;
const searchBatch = 25;

const pruneSchema = stateSchema.pick({ runId: true, pid: true, pidStart: true, updatedAt: true }).extend({
  target: z.object({ repo: z.string(), commit: z.union([z.hash("sha1"), z.hash("sha256")]), dirty: z.boolean() }),
});

const pullStates = ["OPEN", "CLOSED", "MERGED"] as const;
type PullState = (typeof pullStates)[number];
const searchSchema = z.object({
  data: z.record(z.string(), z.object({ issueCount: z.int(), nodes: z.array(z.object({ state: z.enum(pullStates) })) })),
});

async function searchPulls(commits: string[]): Promise<Map<string, PullState[] | null>> {
  const found = new Map<string, PullState[] | null>();
  for (let start = 0; start < commits.length; start += searchBatch) {
    const batch = commits.slice(start, start + searchBatch);
    const names = batch.map((_, index) => `c${index}`);
    const fields = names.map((name) => `${name}: search(query: $${name}, type: ISSUE, first: 100) { issueCount nodes { ... on PullRequest { state } } }`);
    const query = `query(${names.map((name) => `$${name}: String!`).join(", ")}) { ${fields.join(" ")} }`;
    const variables = batch.flatMap((commit, index) => ["-f", `c${index}=${commit} is:pr`]);
    const { data } = searchSchema.parse(JSON.parse(await execute(["gh", "api", "graphql", "-f", `query=${query}`, ...variables])));
    for (const [index, commit] of batch.entries()) {
      const result = data[`c${index}`];
      if (result === undefined) throw new Error(`GitHub returned no search result for ${commit}`);
      found.set(commit, result.issueCount === result.nodes.length ? result.nodes.map((node) => node.state) : null);
    }
  }
  return found;
}

async function mergedCommits(repo: string, commit: string): Promise<string[]> {
  if (!existsSync(repo)) return [];
  const exists = ["git", "-C", repo, "cat-file", "-e", "--end-of-options", commit];
  const result = await capture(exists);
  if (result.code === 1) return [];
  if (result.code !== 0) throw failure(exists, result.code, result.stderr);
  const parents = (await execute(["git", "-C", repo, "show", "-s", "--format=%P", "--end-of-options", commit])).trim().split(" ");
  return parents.length > 1 ? parents : [];
}

async function shippedCommits(targets: Map<string, string>): Promise<Set<string>> {
  const repos = new Map(targets);
  const pulls = new Map<string, PullState[] | null>();
  const merges = new Map<string, string[]>();
  for (let pending = [...repos.keys()]; pending.length > 0; ) {
    for (const [commit, states] of await searchPulls(pending)) pulls.set(commit, states);
    const next: string[] = [];
    for (const commit of pending) {
      const repo = repos.get(commit);
      if (repo === undefined || pulls.get(commit)?.length !== 0) continue;
      const parents = await mergedCommits(repo, commit);
      merges.set(commit, parents);
      for (const parent of parents.filter((parent) => !repos.has(parent))) {
        repos.set(parent, repo);
        next.push(parent);
      }
    }
    pending = next;
  }
  const shipped = (commit: string): boolean => {
    const states = pulls.get(commit);
    if (states === null || states === undefined) return false;
    if (states.length > 0) return !states.includes("OPEN");
    const parents = merges.get(commit) ?? [];
    return parents.length > 0 && parents.every(shipped);
  };
  return new Set([...targets.keys()].filter(shipped));
}

async function removeRun(dir: string): Promise<void> {
  for (const entry of await readdir(dir)) if (entry !== "state.json") await rm(join(dir, entry), { recursive: true, force: true });
  await rm(dir, { recursive: true, force: true });
}

async function replaySource(dir: string): Promise<string | null> {
  const file = join(dir, "findings.json");
  return existsSync(file) ? ((await readJson(file, storedRunSchema)).run.replay?.runId ?? null) : null;
}

type Candidate = { dir: string; runId: string; target: { repo: string; commit: string } | null; source: string | null };

export async function prune(print: (line: string) => void): Promise<void> {
  const root = runsDir();
  const dirs = existsSync(root)
    ? (await readdir(root, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => join(root, entry.name))
    : [];
  const host = await hostObjects();
  const kept = { active: 0, dirty: 0, leftovers: 0, unshipped: 0, replayed: 0 };
  const sources = new Set<string>();
  const candidates: Candidate[] = [];
  for (const dir of dirs) {
    const file = join(dir, "state.json");
    const state = existsSync(file) ? await readJson(file, pruneSchema) : null;
    if (state !== null && running(state.pid, state.pidStart)) {
      kept.active++;
      continue;
    }
    const runId = state?.runId ?? basename(dir);
    const source = await replaySource(dir);
    const changed = state === null ? (await stat(dir)).mtimeMs : Date.parse(state.updatedAt);
    if (Date.now() - changed < settleMs) kept.active++;
    else if (state?.target.dirty === true) kept.dirty++;
    else if (await leftBehind(host, dir, runId)) kept.leftovers++;
    else {
      candidates.push({ dir, runId, target: state?.target ?? null, source });
      continue;
    }
    if (source !== null) sources.add(source);
  }
  const shipped = await shippedCommits(new Map(candidates.flatMap(({ target }) => (target === null ? [] : [[target.commit, target.repo] as const]))));
  const unshipped = candidates.filter(({ target }) => target !== null && !shipped.has(target.commit));
  for (const { source } of unshipped) if (source !== null) sources.add(source);
  kept.unshipped = unshipped.length;
  let removed = 0;
  for (const { dir, runId } of candidates.filter((candidate) => !unshipped.includes(candidate))) {
    const lock = sources.has(runId) ? null : flock(replayLock(dir), "--exclusive", "--nonblock");
    if (lock === null) {
      kept.replayed++;
      continue;
    }
    try {
      await removeRun(dir);
    } finally {
      closeSync(lock);
    }
    removed++;
    print(`Removed run ${runId}.`);
  }
  print(
    `Removed ${removed} of ${dirs.length} run directories. Kept ${kept.active} running or changed within 24 hours, ${kept.dirty} run with --dirty, ${kept.leftovers} with teardown leftovers that qa-interns down removes, ${kept.unshipped} whose job has not shipped, and ${kept.replayed} whose findings a kept run replays.`,
  );
}
