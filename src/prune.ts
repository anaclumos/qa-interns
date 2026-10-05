import { existsSync } from "node:fs";
import { readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { hostObjects, leftBehind } from "./environment.ts";
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

export async function prune(print: (line: string) => void): Promise<void> {
  const root = runsDir();
  const dirs = existsSync(root) ? (await readdir(root)).map((name) => join(root, name)) : [];
  const host = await hostObjects();
  const kept = { active: 0, dirty: 0, leftovers: 0, unshipped: 0 };
  const candidates: { dir: string; runId: string; repo: string; commit: string }[] = [];
  for (const dir of dirs) {
    const file = join(dir, "state.json");
    const { runId, pid, pidStart, updatedAt, target } = await readJson(file, pruneSchema, `No run state at ${file}`);
    if (running(pid, pidStart) || Date.now() - Date.parse(updatedAt) < settleMs) kept.active++;
    else if (target.dirty) kept.dirty++;
    else if (await leftBehind(host, dir, runId)) kept.leftovers++;
    else candidates.push({ dir, runId, repo: target.repo, commit: target.commit });
  }
  const shipped = await shippedCommits(new Map(candidates.map(({ commit, repo }) => [commit, repo])));
  for (const { dir, runId, commit } of candidates) {
    if (!shipped.has(commit)) {
      kept.unshipped++;
      continue;
    }
    await removeRun(dir);
    print(`Removed run ${runId}.`);
  }
  const removed = candidates.length - kept.unshipped;
  print(
    `Removed ${removed} of ${dirs.length} run directories. Kept ${kept.active} running or changed within 24 hours, ${kept.dirty} run with --dirty, ${kept.leftovers} with teardown leftovers that qa-interns down removes, and ${kept.unshipped} whose job has not shipped.`,
  );
}
