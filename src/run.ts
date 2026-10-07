import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { openSession, type Session } from "./acp.ts";
import {
  buildImages,
  containerStats,
  environmentMemory,
  freeSlot,
  freeSlots,
  holdRun,
  networkRange,
  readRelayLogs,
  removeCopies,
  removeCopy,
  runnerEnv,
  saveDisks,
  startEnvironment,
  stopEnvironment,
  stopProject,
  stopRun,
  sweepImages,
  sweepRuns,
  watchOut,
  writeChromePolicy,
  type Environment,
  type EnvironmentSpec,
  type HeldSlot,
} from "./environment.ts";
import { message, oneLine, outDir, parseGroups, readAgentFile, readConfirmation, readFindings, stripControl } from "./findings.ts";
import { admit, loadLogin, Scheduler, watchReleases, type Lease } from "./logins.ts";
import { credentialRule, pi, readKey } from "./pi.ts";
import { confirmPrompt, continuePrompt, correctionPrompt, deck, internPrompt, judgePrompt, timeUpPrompt, type PromptEnvironment } from "./prompt.ts";
import { browserVersion } from "./runner.ts";
import { confirms, lead, renderReplay, renderReport, writeTickets } from "./report.ts";
import { forgetSecrets, hasSecrets, keepLoginKey, redact, redactFiles, redactJson } from "./secrets.ts";
import { newRunId, processStart, runDirFor, runsDir, writeAtomic, writeState } from "./state.ts";
import { execute, exportTree, killCommands, loadTarget, resolveTarget, trackGroup, type Target, type TargetRef } from "./target.ts";
import type { Answer, EnvironmentStats, Finding, FindingEnvironment, Group, InternState, Rejected, Replay, RunPhase, RunState } from "./types.ts";

export type RunOptions = {
  dir: string;
  rev: string;
  dirty: boolean;
  interns: number;
  minutes: number;
  confirmMinutes: number;
  focus?: number[];
  loginsFile: string;
  replay: Replay | null;
  onEnd?: string;
  runnerImage(): Promise<string>;
  admit: Admit;
  print(line: string): void;
};

export type CopyOptions = {
  dir: string;
  rev: string;
  runnerImage(): Promise<string>;
  print(line: string): void;
};

export type AskOptions = {
  runDir: string;
  runId: string;
  name: string;
  loginsFile: string;
  runnerImage: string;
  admit: Admit;
  prompt: string;
  file: string;
  parse(raw: string): unknown;
};

type Admit = (memory: number) => (() => void) | null;

type Turn = Awaited<ReturnType<Session["prompt"]>>;
type Limit = <T>(task: (free: () => void) => Promise<T>) => Promise<T>;
type Note = (text: string) => Promise<void>;
type Work<T> = (session: Session, env: Environment, note: Note) => Promise<T>;
type Outcome<T> = { status: "done"; value: T } | { status: "limited" } | { status: "failed"; error: unknown };
type Explored = { intern: InternState; environment: FindingEnvironment | null };
type Collected = { findings: Finding[]; rejected: Rejected[]; failures: unknown[] };
type Reproduced = { intern: InternState; group: Group; ran: boolean };

class Unanswered extends Error {}

type Context = {
  runId: string;
  runDir: string;
  runnerImage: string;
  scheduler: Scheduler | null;
  admit: Admit;
  images: Record<string, string>;
  sessions: Set<Session>;
  teardowns: string[];
  unremoved: Set<string>;
  environments: EnvironmentStats[];
  waiting: Set<() => void>;
  stopping: boolean;
  tearingDown: boolean;
  update(id: string, patch: Partial<InternState>): Promise<void>;
};

const signals = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
let guarded = 0;
const minute = 60_000;
const askMinutes = 10;
const settleMs = 60_000;
const writeUpMs = 4 * minute;
const stopWaitMs = 30_000;
const waitMs = 30_000;
const noLogin = "no login has spare capacity";
const copyName = "up";

function now(): string {
  return new Date().toISOString();
}

function limit(size: number): Limit {
  let active = 0;
  const queue: (() => void)[] = [];
  return async <T>(task: (free: () => void) => Promise<T>): Promise<T> => {
    if (active < size) active += 1;
    else await new Promise<void>((resolve) => queue.push(resolve));
    let held = true;
    const free = () => {
      if (!held) return;
      held = false;
      const next = queue.shift();
      if (next === undefined) active -= 1;
      else next();
    };
    try {
      return await task(free);
    } finally {
      free();
    }
  };
}

async function settle<T>(tasks: Promise<T>[]): Promise<T[]> {
  const values: T[] = [];
  for (const result of await Promise.allSettled(tasks)) {
    if (result.status === "rejected") throw result.reason;
    values.push(result.value);
  }
  return values;
}

async function within<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), Math.max(0, ms));
  });
  try {
    return await Promise.race([promise, expired]);
  } finally {
    clearTimeout(timer);
  }
}

function checkStopping(ctx: Context): void {
  if (ctx.stopping) throw new Error("interrupted");
}

function context(runId: string, runDir: string, runnerImage: string, scheduler: Scheduler | null, admit: Admit, update: Context["update"]): Context {
  return {
    runId,
    runDir,
    runnerImage,
    scheduler,
    admit,
    images: {},
    sessions: new Set(),
    teardowns: [],
    unremoved: new Set(),
    environments: [],
    waiting: new Set(),
    stopping: false,
    tearingDown: false,
    update,
  };
}

async function acquire(ctx: Context, scheduler: Scheduler): Promise<Lease | null> {
  for (;;) {
    checkStopping(ctx);
    const released = Promise.withResolvers<void>();
    const wake = () => released.resolve();
    const unwatch = watchReleases(wake);
    ctx.waiting.add(wake);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const leased = scheduler.leased();
      const lease = scheduler.acquire();
      if (lease !== null) return lease;
      if (!scheduler.lost() && !scheduler.leased()) {
        if (!leased) return null;
        continue;
      }
      timer = setTimeout(wake, waitMs);
      await released.promise;
    } finally {
      clearTimeout(timer);
      ctx.waiting.delete(wake);
      unwatch();
    }
  }
}

async function admitted(ctx: Context, memory: number): Promise<() => void> {
  for (;;) {
    checkStopping(ctx);
    const released = Promise.withResolvers<void>();
    const wake = () => released.resolve();
    const unwatch = watchReleases(wake);
    ctx.waiting.add(wake);
    const timer = setTimeout(wake, waitMs);
    try {
      const started = ctx.admit(memory);
      if (started !== null) return started;
      await released.promise;
    } finally {
      clearTimeout(timer);
      ctx.waiting.delete(wake);
      unwatch();
    }
  }
}

function environmentSpec(ctx: Context, name: string, slot: number, target: Target | null, lease: Lease): EnvironmentSpec {
  const key = readKey(lease.credential);
  if (key === null) throw new Error(`login ${lease.login.id}: ${lease.credential} ${credentialRule}`);
  keepLoginKey(key, lease.login.id);
  return {
    runId: ctx.runId,
    runDir: ctx.runDir,
    name,
    slot,
    target,
    images: target === null ? {} : ctx.images,
    runner: {
      image: ctx.runnerImage,
      out: join(ctx.runDir, outDir(name)),
      env: { ...runnerEnv(target === null ? {} : target.settings.urls), ...pi.env },
      mounts: pi.mounts(lease.credential),
      tmpfs: pi.tmpfs,
    },
    egress: pi.egress,
  };
}

async function withSession<T>(ctx: Context, id: string, env: Environment, lease: Lease, work: Work<T>, note: Note): Promise<T> {
  let session: Session | undefined;
  const done = new AbortController();
  try {
    session = await openSession({
      container: env.runner,
      adapter: pi.adapter,
      model: lease.login.model,
      transcript: join(ctx.runDir, "interns", id, "transcript.jsonl"),
      adapterLog: join(ctx.runDir, "interns", id, "adapter.log"),
    });
    ctx.sessions.add(session);
    checkStopping(ctx);
    await ctx.update(id, { status: "testing", model: session.model });
    let stopped = false;
    const live: Note = async (text) => {
      if (!stopped) await note(text);
    };
    const result = await Promise.race([work(session, env, live).then((value) => ({ value })), watchOut(env.out, done.signal)]);
    if (typeof result !== "string") return result.value;
    stopped = true;
    await execute(["docker", "kill", env.runner]);
    throw new Error(`${result}, so its runner was stopped`);
  } finally {
    done.abort();
    if (session !== undefined) {
      ctx.sessions.delete(session);
      await session.close();
    }
  }
}

async function leased<T>(ctx: Context, id: string, target: Target | null, free: () => void, work: Work<T>, note: Note): Promise<{ value: T } | null> {
  const project = `qa-${ctx.runId}-${id}`;
  let lease: Lease | null = null;
  let starting = () => {};
  let slot: HeldSlot | undefined;
  let started = false;
  let removed = false;
  let unread = null as EnvironmentStats | null;
  const releaseSlot = () => {
    starting();
    slot?.release();
    slot = undefined;
  };
  const teardown = async (handOff: () => void) => {
    const environment = unread;
    unread = null;
    try {
      if (environment !== null) environment.containers = await containerStats(project);
    } finally {
      await stopEnvironment(ctx.runDir, id, project, ctx.runnerImage, () => {
        removed = true;
        handOff();
      });
    }
  };
  try {
    if (ctx.scheduler === null) throw new Error(`Run ${ctx.runId} has no login`);
    lease = await acquire(ctx, ctx.scheduler);
    if (lease === null) return null;
    starting = await admitted(ctx, environmentMemory(target));
    await ctx.update(id, { status: "starting", login: lease.login.id, project, startedAt: now() });
    for (;;) {
      checkStopping(ctx);
      slot = await freeSlot();
      const environment: EnvironmentStats = { intern: id, startedAt: now(), readyAt: null, containers: null };
      ctx.environments.push(environment);
      started = true;
      removed = false;
      unread = environment;
      const env = await startEnvironment(environmentSpec(ctx, id, slot.slot, target, lease), () => {
        environment.readyAt = now();
      }).finally(starting);
      try {
        return { value: await withSession(ctx, id, env, lease, work, note) };
      } catch (error) {
        if (!(error instanceof Unanswered)) throw error;
        await note(error.message);
      }
      await teardown(releaseSlot);
      started = false;
      await ctx.update(id, { status: "starting" });
    }
  } catch (error) {
    await note(ctx.stopping ? "interrupted" : message(error));
    throw error;
  } finally {
    const handOff = () => {
      releaseSlot();
      lease?.release();
      free();
    };
    try {
      if (started) await teardown(handOff);
    } catch (error) {
      if (!removed) ctx.unremoved.add(id);
      ctx.teardowns.push(`${id}: ${message(error)}`);
      await note(`teardown failed: ${message(error)}`);
    } finally {
      handOff();
    }
  }
}

async function agentTask<T>(ctx: Context, id: string, target: Target | null, free: () => void, work: Work<T>): Promise<Outcome<T>> {
  const notes: string[] = [];
  const detail = () => (notes.length === 0 ? null : stripControl(notes.join("; ")));
  const note = async (text: string) => {
    notes.push(text);
    await ctx.update(id, { detail: detail() });
  };
  let outcome: Outcome<T>;
  try {
    const result = await leased(ctx, id, target, free, work, note);
    if (result !== null && ctx.unremoved.has(id)) throw new Error("its environment was not removed, so its runner may still write to /qa/out and its output was not read");
    outcome = result === null ? { status: "limited" } : { status: "done", value: result.value };
    if (result === null) notes.push(noLogin);
  } catch (error) {
    outcome = { status: "failed", error };
  }
  await ctx.update(id, { status: outcome.status, detail: detail(), endedAt: now() });
  return outcome;
}

async function turnUntil(session: Session, text: string, deadline: number): Promise<Turn | "ended" | "running"> {
  if (Date.now() >= deadline) return "ended";
  const turn = session.prompt(text);
  const result = await within(turn, deadline - Date.now());
  if (result !== null) return result;
  const settled = turn.then(
    () => "ended" as const,
    () => "ended" as const,
  );
  await session.cancel();
  return (await within(settled, settleMs)) ?? "running";
}

async function converse(session: Session, first: string, deadline: number, next: (turn: Turn, idle: boolean) => Promise<string | null>): Promise<"done" | "ended" | "running"> {
  let text: string | null = first;
  let quiet = false;
  while (text !== null) {
    const turn = await turnUntil(session, text, deadline);
    if (typeof turn === "string") return turn;
    const idle = quiet && turn.toolCalls === 0;
    quiet = turn.toolCalls === 0;
    text = await next(turn, idle);
  }
  return "done";
}

function minutesLeft(deadline: number): number {
  return Math.max(0, Math.ceil((deadline - Date.now()) / minute));
}

function promptEnvironment(target: Target, env: Environment, minutes: number): PromptEnvironment {
  return { urls: target.settings.urls, seed: env.seed, minutes, offLimits: target.settings.offLimits };
}

async function askWith<T>(ctx: Context, id: string, prompt: string, file: string, parse: (raw: string) => T): Promise<T> {
  let unanswered = false;
  const outcome = await agentTask(ctx, id, null, () => {}, async (session) => {
    const path = join(ctx.runDir, outDir(id), file);
    await rm(path, { force: true });
    let parsed = null as { value: T } | null;
    let corrected = false;
    await converse(session, prompt, Date.now() + askMinutes * minute, async () => {
      try {
        parsed = { value: parse(await readAgentFile(path)) };
        return null;
      } catch (error) {
        if (corrected) throw new Error(`/qa/out/${file} is still invalid after one correction: ${message(error)}`);
        corrected = true;
        return correctionPrompt(`/qa/out/${file}`, message(error));
      }
    });
    if (parsed === null && (await Bun.file(path).exists())) {
      try {
        parsed = { value: parse(await readAgentFile(path)) };
      } catch (error) {
        throw new Error(`${id} wrote no valid /qa/out/${file} within ${askMinutes} minutes: ${message(error)}`);
      }
    }
    if (parsed === null) {
      const reason = `${id} wrote no valid /qa/out/${file} within ${askMinutes} minutes`;
      if (unanswered) throw new Error(reason);
      unanswered = true;
      throw new Unanswered(`${reason}; starting it again in a fresh environment`);
    }
    return parsed.value;
  });
  if (outcome.status === "failed") throw outcome.error;
  if (outcome.status === "limited") throw new Error(`No login has spare capacity for ${id}`);
  return outcome.value;
}

async function collect(ctx: Context, { intern, environment }: Explored): Promise<Collected> {
  if (environment === null || ctx.unremoved.has(intern.id)) return { findings: [], rejected: [], failures: [] };
  try {
    const { findings, rejected } = await readFindings(ctx.runDir, intern.id, environment);
    return { findings, rejected, failures: [] };
  } catch (reason) {
    return { findings: [], rejected: [], failures: [reason] };
  }
}

async function count(ctx: Context, { intern }: Explored, collected: Collected): Promise<Collected> {
  await ctx.update(intern.id, { findings: collected.findings.length, rejected: collected.rejected.length });
  return collected;
}

async function explore(ctx: Context, explored: Explored, target: Target, minutes: number, free: () => void): Promise<{ outcome: Outcome<void> } & Collected> {
  const { intern } = explored;
  const outcome = await agentTask(ctx, intern.id, target, free, async (session, env, note) => {
    const found = { commit: target.commit, dirty: target.dirty, environment: env.project, model: session.model };
    explored.environment = found;
    const start = Date.now();
    const deadline = start + minutes * minute;
    await converse(session, internPrompt(intern.charter, promptEnvironment(target, env, minutes), target.settings.knownGaps, target.settings.intendedBehaviors), deadline, async (turn, idle) => {
      if (idle) {
        const stopped = `stopped at minute ${Math.floor((Date.now() - start) / minute)}`;
        if (session.toolCalls() === 0) throw new Error(`${stopped} without a tool call: "${turn.lastMessage}"`);
        await note(`${stopped}: "${turn.lastMessage}"`);
        return null;
      }
      const { rejected } = await readFindings(ctx.runDir, intern.id, found);
      return continuePrompt(minutesLeft(deadline), rejected, outDir(intern.id));
    });
    if (session.toolCalls() === 0) throw new Error(`made no tool call in its ${minutes} minutes`);
  });
  const collected = await collect(ctx, explored);
  if (collected.failures.length > 0) throw collected.failures[0];
  if (!ctx.stopping) await count(ctx, explored, collected);
  return { outcome, ...collected };
}

async function check(ctx: Context, id: string): Promise<Answer> {
  try {
    return { result: await readConfirmation(ctx.runDir, id), error: null };
  } catch (error) {
    return { result: null, error: message(error) };
  }
}

async function recover(ctx: Context, { intern, ran }: Reproduced, answer: Answer): Promise<NonNullable<Group["confirmation"]>> {
  const saved = ran && !ctx.unremoved.has(intern.id) ? await check(ctx, intern.id) : null;
  return { intern: intern.id, ...(saved !== null && (saved.result !== null || answer.error === null) ? saved : answer) };
}

async function reproduce(ctx: Context, reproduced: Reproduced, target: Target, minutes: number, free: () => void): Promise<void> {
  const { intern, group } = reproduced;
  const finding = lead(group);
  const outcome = await agentTask(ctx, intern.id, target, free, async (session, env, note) => {
    reproduced.ran = true;
    const out = outDir(intern.id);
    const file = join(ctx.runDir, out, "confirmation.json");
    const deadline = Date.now() + minutes * minute;
    let answer: Answer = { result: null, error: "no confirmation.json written" };
    let corrected = false;
    const end = await converse(session, confirmPrompt(finding, promptEnvironment(target, env, minutes), target.settings.intendedBehaviors), deadline, async (_turn, idle) => {
      if (!(await Bun.file(file).exists())) return idle ? null : continuePrompt(minutesLeft(deadline), [], out);
      answer = await check(ctx, intern.id);
      if (answer.error === null || corrected) return null;
      corrected = true;
      return correctionPrompt("/qa/out/confirmation.json", answer.error);
    });
    if (end === "ended" && !(await Bun.file(file).exists())) await turnUntil(session, timeUpPrompt(), Date.now() + writeUpMs);
    if (answer.result === null && (await Bun.file(file).exists())) answer = await check(ctx, intern.id);
    await note(answer.result === null ? `confirmation failed: ${answer.error}` : confirms(answer.result) ? "reproduced" : "did not reproduce");
    return answer;
  });
  const answer: Answer = outcome.status === "done" ? outcome.value : { result: null, error: outcome.status === "limited" ? noLogin : message(outcome.error) };
  const confirmation = await recover(ctx, reproduced, answer);
  if (answer.error === null && confirmation.result === null) await ctx.update(intern.id, { detail: stripControl(`${intern.detail}; confirmation failed after teardown: ${confirmation.error}`) });
  if (!ctx.stopping) group.confirmation = confirmation;
}

function internState(id: string, role: InternState["role"], charter: string, group: string | null): InternState {
  return {
    id,
    role,
    charter,
    group,
    login: null,
    model: null,
    project: null,
    status: "queued",
    detail: null,
    findings: 0,
    rejected: 0,
    startedAt: null,
    endedAt: null,
  };
}

function progress(intern: InternState): string {
  if (intern.status === "starting" || intern.status === "testing") return `${intern.id} ${intern.status} on ${intern.login}`;
  if (intern.detail === null) return `${intern.id} ${intern.status}`;
  return `${intern.id} ${intern.status}: ${oneLine(redact(intern.detail)).slice(-300)}`;
}

function once<A extends unknown[], R>(fn: (...args: A) => Promise<R>): (...args: A) => Promise<R> {
  let result: Promise<R> | undefined;
  return (...args) => (result ??= fn(...args));
}

function finisher<A extends unknown[], R>(ctx: Context, fn: (...args: A) => Promise<R>): (...args: A) => Promise<R> {
  return once(async (...args) => {
    ctx.tearingDown = true;
    try {
      return await fn(...args);
    } finally {
      ctx.tearingDown = false;
    }
  });
}

async function stop(ctx: Context, running: Promise<unknown> | undefined): Promise<void> {
  ctx.stopping = true;
  for (const wake of ctx.waiting) wake();
  if (!ctx.tearingDown) killCommands();
  const closed = await Promise.allSettled(
    [...ctx.sessions].map(async (session) => {
      try {
        await session.cancel();
      } finally {
        await session.close();
      }
    }),
  );
  for (const result of closed) if (result.status === "rejected") process.stderr.write(`Closing a session failed: ${message(result.reason)}\n`);
  await within(Promise.allSettled([running]), stopWaitMs);
}

async function guard<T>(ctx: Context, body: () => Promise<T>, interrupted: () => Promise<void>, snapshot: () => Promise<void> = async () => {}): Promise<T> {
  let running: Promise<T> | undefined;
  let signalled = false;
  const handler = () => {
    if (signalled) return;
    signalled = true;
    process.stderr.write("Interrupted. Closing sessions and tearing down.\n");
    Promise.all([
      stop(ctx, running),
      snapshot().catch((error) => {
        process.stderr.write(`Writing the report after the interrupt failed: ${redact(message(error))}\n`);
      }),
    ])
      .then(interrupted)
      .then(
        () => process.exit(130),
        (error) => {
          process.stderr.write(`Teardown after the interrupt failed: ${message(error)}\n`);
          process.exit(130);
        },
      );
  };
  for (const signal of signals) process.on(signal, handler);
  guarded += 1;
  try {
    running = body();
    const [result] = await Promise.allSettled([running]);
    if (ctx.stopping) return await new Promise<never>(() => {});
    if (result.status === "rejected") throw result.reason;
    return result.value;
  } finally {
    for (const signal of signals) process.off(signal, handler);
    guarded -= 1;
    if (guarded === 0) forgetSecrets();
  }
}

export async function ask(opts: AskOptions): Promise<unknown> {
  const scheduler = new Scheduler(await loadLogin(opts.loginsFile));
  const ctx = context(opts.runId, opts.runDir, opts.runnerImage, scheduler, opts.admit, async () => {});
  const project = `qa-${opts.runId}-${opts.name}`;
  const held = holdRun(opts.runId, opts.runDir);
  const finish = finisher(ctx, async (): Promise<string | null> => {
    const teardowns = [...ctx.teardowns];
    try {
      await stopProject(project, join(opts.runDir, "interns", opts.name));
      await removeCopy(opts.runDir, opts.runId, opts.name, opts.runnerImage);
      await saveDisks(opts.runDir, opts.name, project, opts.runnerImage);
      held.end();
    } catch (reason) {
      teardowns.push(message(reason));
    }
    const dirs = [join(opts.runDir, "envs", opts.name), join(opts.runDir, "interns", opts.name)];
    if (teardowns.length > ctx.teardowns.length) {
      if (hasSecrets()) teardowns.push(`secret values stay in the files under ${dirs.join(" and ")}`);
    } else {
      try {
        await redactFiles(dirs);
      } catch (reason) {
        teardowns.push(`secret values stay in the files under ${dirs.join(" and ")}: ${message(reason)}`);
      }
    }
    return teardowns.length === 0 ? null : `Teardown of ${project} failed: ${teardowns.join("; ")}`;
  });
  return guard(
    ctx,
    async () => {
      const [result] = await Promise.allSettled([askWith(ctx, opts.name, opts.prompt, opts.file, opts.parse)]);
      const teardown = await finish();
      if (teardown !== null) throw new Error(redact(result.status === "rejected" ? `${message(result.reason)}; ${teardown}` : teardown));
      if (result.status === "rejected") throw new Error(redact(message(result.reason)));
      return result.value;
    },
    async () => {
      const teardown = await finish();
      if (teardown !== null) throw new Error(redact(teardown));
    },
  );
}

async function newRun(ref: TargetRef, options: RunState["options"], print: (line: string) => void) {
  const runId = newRunId();
  const runDir = runDirFor(runId);
  const held = holdRun(runId, runDir);
  await mkdir(runsDir(), { recursive: true });
  await mkdir(runDir);
  const state: RunState = {
    runId,
    pid: process.pid,
    pidStart: processStart(process.pid),
    target: { repo: ref.repo, path: ref.path, commit: ref.commit, dirty: ref.dirty },
    options,
    phase: "preparing",
    error: null,
    startedAt: now(),
    updatedAt: now(),
    endedAt: null,
    interns: [],
  };
  const save = async () => {
    state.updatedAt = now();
    await writeState(runDir, redactJson(state));
  };
  await save();
  print(runDir);
  print(`phase ${state.phase}`);
  return { runId, runDir, state, save, held };
}

export async function startCopy(opts: CopyOptions): Promise<string> {
  const ref = await resolveTarget(opts.dir, opts.rev, false);
  const { runId, runDir, state, save, held } = await newRun(ref, { interns: 0, minutes: 0, confirmMinutes: 0, concurrency: 0, confirmConcurrency: 0 }, opts.print);
  const ctx = context(runId, runDir, "", null, admit, async () => {});
  const dirs = [join(runDir, "envs"), join(runDir, "interns")];
  const phase = async (next: RunPhase) => {
    checkStopping(ctx);
    state.phase = next;
    opts.print(`phase ${next}`);
    await save();
  };
  const finish = finisher(ctx, async (error: string | null): Promise<void> => {
    const problems: string[] = [];
    for (const step of [() => stopRun(runDir, runId), () => removeCopies(runDir, runId, ctx.runnerImage)]) {
      try {
        await step();
      } catch (reason) {
        problems.push(`teardown failed: ${message(reason)}`);
      }
    }
    if (problems.length > 0) {
      if (hasSecrets()) problems.push(`secret values stay in the files under ${dirs.join(" and ")}`);
    } else {
      held.end();
      try {
        await redactFiles(dirs);
      } catch (reason) {
        problems.push(`secret values stay in the files under ${dirs.join(" and ")}: ${message(reason)}`);
      }
    }
    state.phase = "failed";
    state.error = stripControl([ctx.stopping ? "interrupted" : null, error, ...problems].filter((entry) => entry !== null).join("; "));
    state.endedAt = now();
    await save();
  });
  return guard(
    ctx,
    async () => {
      let slot: HeldSlot | undefined;
      try {
        ctx.runnerImage = await opts.runnerImage();
        for (const error of await sweepRuns(ctx.runnerImage)) process.stderr.write(`${redact(error)}\n`);
        const source = join(runDir, "source");
        await exportTree(ref, source);
        const target = await loadTarget(ref, source);
        await writeChromePolicy(runDir, target.settings.urls);
        await phase("building");
        const { images } = await buildImages(runId, target, source, join(runDir, "build.log"));
        await phase("starting");
        slot = await freeSlot();
        const env = await startEnvironment({
          runId,
          runDir,
          name: copyName,
          slot: slot.slot,
          target,
          images,
          runner: { image: ctx.runnerImage, out: join(runDir, outDir(copyName)), env: runnerEnv(target.settings.urls), mounts: [], tmpfs: [] },
          egress: [],
        });
        const envDir = join(runDir, "envs", copyName);
        await redactFiles([join(runDir, "envs")], new Set([env.project, "tmp"].map((entry) => join(envDir, entry))));
        await phase("up");
        held.end();
        opts.print(`project ${env.project}`);
        opts.print(`runner ${env.runner}`);
        opts.print(`dev container ${env.devContainer}`);
        opts.print(`seed ${JSON.stringify(env.seed)}`);
        opts.print(`Remove it with qa-interns down ${runId}.`);
      } catch (error) {
        if (!ctx.stopping) await finish(message(error));
        throw new Error(redact(message(error)));
      } finally {
        slot?.release();
      }
      return runDir;
    },
    () => finish(null),
  );
}

export async function runQa(opts: RunOptions): Promise<string> {
  const scheduler = new Scheduler(await loadLogin(opts.loginsFile));
  const ref = await resolveTarget(opts.dir, opts.rev, opts.dirty);
  const options = { interns: opts.interns, minutes: opts.minutes, confirmMinutes: opts.confirmMinutes, concurrency: 0, confirmConcurrency: 0 };
  const { runId, runDir, state, save, held } = await newRun(ref, options, opts.print);

  const ctx = context(runId, runDir, "", scheduler, opts.admit, async (id, patch) => {
    const intern = state.interns.find((entry) => entry.id === id);
    if (intern === undefined) throw new Error(`Run ${runId} has no intern ${id}`);
    const changed = (patch.status !== undefined && patch.status !== intern.status) || (patch.login !== undefined && patch.login !== intern.login);
    Object.assign(intern, patch);
    if (changed) opts.print(progress(intern));
    await save();
  });
  const phase = async (next: RunPhase) => {
    checkStopping(ctx);
    state.phase = next;
    opts.print(`phase ${next}`);
    await save();
  };

  let explored: Explored[] = [];
  let reproduced: Reproduced[] = [];
  let findings: Finding[] = [];
  let rejected: Rejected[] = [];
  let groups: Group[] | null = opts.replay?.groups ?? null;
  let egress: string[] = [];
  let browser: string | null = null;
  let releaseImages = async () => {};

  let recorded: { error: string | null; teardowns: string[]; stopping: boolean } | undefined;

  const record = (error: string | null, teardowns: string[]) => {
    recorded = { error, teardowns, stopping: ctx.stopping };
    const problems = [ctx.stopping ? "interrupted" : null, error, ...teardowns.map((teardown) => `teardown failed: ${teardown}`)].filter((entry) => entry !== null);
    state.phase = problems.length === 0 ? "done" : "failed";
    state.error = problems.length === 0 ? null : stripControl(problems.join("; "));
    state.endedAt = now();
  };

  const write = async () => {
    const singles = findings.map((finding, index) => ({ id: `g${index + 1}`, findings: [finding], confirmation: null }));
    const logs = await Promise.all(state.interns.map(async (intern) => (await readRelayLogs(join(runDir, "interns", intern.id))).map((records) => ({ intern: intern.id, records }))));
    const traffic = redactJson({ hosts: egress, relays: logs.flat() });
    const environments = redactJson(ctx.environments);
    const report =
      opts.replay === null
        ? renderReport(runDir, redactJson(state), browser, redactJson(groups ?? singles), redactJson(rejected), traffic, environments)
        : { ...renderReplay(runDir, redactJson(state), browser, redactJson(opts.replay), traffic, environments), tickets: [] };
    writeAtomic(join(runDir, "report.md"), report.markdown);
    writeAtomic(join(runDir, "findings.json"),`${JSON.stringify(report.json, null, 2)}\n`);
    return report.tickets;
  };

  const snapshot = once(async (error: string | null) => {
    if (error !== null || ctx.stopping) record(error, ctx.teardowns);
    await write();
    await save();
  });

  const finish = finisher(ctx, async (error: string | null): Promise<string | null> => {
    await Promise.allSettled([snapshot(error)]);
    const teardowns: string[] = [];
    for (const step of [() => stopRun(runDir, runId), () => removeCopies(runDir, runId, ctx.runnerImage)]) {
      try {
        await step();
      } catch (reason) {
        teardowns.push(message(reason));
      }
    }
    let failures: unknown[] = [];
    try {
      if (ctx.stopping) {
        for (const intern of state.interns) {
          if (intern.startedAt !== null && intern.endedAt === null) await ctx.update(intern.id, { status: "failed", detail: intern.detail === null ? "interrupted" : `${intern.detail}; interrupted`, endedAt: now() });
        }
        for (const entry of reproduced) entry.group.confirmation ??= await recover(ctx, entry, { result: null, error: "interrupted" });
      }
      if (groups === null) {
        const results = await Promise.all(explored.map(async (entry) => count(ctx, entry, await collect(ctx, entry))));
        findings = results.flatMap((result) => result.findings);
        rejected = results.flatMap((result) => result.rejected);
        failures = results.flatMap((result) => result.failures);
      }
    } finally {
      const dirs = [join(runDir, "envs"), join(runDir, "interns")];
      if (teardowns.length > 0) {
        teardowns.unshift(...ctx.teardowns);
        if (hasSecrets()) teardowns.push(`secret values stay in the files under ${dirs.join(" and ")}`);
      } else {
        held.end();
        try {
          await redactFiles(dirs);
        } catch (reason) {
          teardowns.push(`secret values stay in the files under ${dirs.join(" and ")}: ${message(reason)}`);
        }
      }
    }
    ctx.tearingDown = false;
    try {
      await releaseImages();
      if (!ctx.stopping) await sweepImages();
    } catch (reason) {
      opts.print(redact(message(reason)));
    }
    const problem = [error,...failures.map((failure) => `reading the interns' output failed: ${message(failure)}`)].filter((entry) => entry !== null).join("; ");
    try {
      record(problem === "" ? null : problem, teardowns);
      await writeTickets(runDir, await write());
    } catch (reason) {
      const failed = [problem, `writing the report failed: ${message(reason)}`].filter((entry) => entry !== "").join("; ");
      record(failed, teardowns);
      await save();
      throw new Error(redact(failed));
    }
    await save();
    return teardowns.length === 0 ? null : teardowns.join("; ");
  });

  const phases = async () => {
    const source = join(runDir, "source");
    await exportTree(ref, source);
    const target = await loadTarget(ref, source);
    egress = target.settings.egress;
    const cards = deck(target.settings.focus, opts.focus);
    ctx.runnerImage = await opts.runnerImage();
    for (const error of await sweepRuns(ctx.runnerImage)) process.stderr.write(`${redact(error)}\n`);
    browser = await browserVersion(ctx.runnerImage);
    const slots = await freeSlots();
    if (slots === 0) throw new Error(`No free network slot: every /23 block of QA_INTERNS_SUBNET ${networkRange().subnet} overlaps a Docker network or a host route`);
    const width = Math.min(scheduler.capacity(), slots);
    state.options.concurrency = Math.min(opts.interns, width);
    state.interns = Array.from({ length: opts.interns }, (_, index) => {
      const charter = cards[index % cards.length];
      if (charter === undefined) throw new Error("The charter deck is empty");
      return internState(`i${index + 1}`, "intern", charter, null);
    });
    await writeChromePolicy(runDir, target.settings.urls);
    await save();

    await phase("building");
    const built = await buildImages(runId, target, source, join(runDir, "build.log"));
    releaseImages = built.release;
    ctx.images = built.images;

    if (groups === null) {
      await phase("testing");
      const testing = limit(state.options.concurrency);
      explored = state.interns.map((intern) => ({ intern, environment: null }));
      const ended: Awaited<ReturnType<typeof explore>>[] = [];
      const results = await settle(
        explored.map((entry, index) =>
          testing(async (free) => {
            const result = await explore(ctx, entry, target, opts.minutes, free);
            ended[index] = result;
            if (!ctx.stopping) {
              findings = ended.flatMap((one) => one.findings);
              rejected = ended.flatMap((one) => one.rejected);
            }
            return result;
          }),
        ),
      );
      checkStopping(ctx);
      findings = results.flatMap((result) => result.findings);
      rejected = results.flatMap((result) => result.rejected);
      if (results.every((result) => result.outcome.status !== "done")) {
        throw new Error(`No testing intern completed: ${state.interns.map((intern) => `${intern.id} ${intern.status}: ${intern.detail}`).join("; ")}`);
      }

      await phase("grouping");
      let members = findings.map((finding) => [finding.id]);
      if (findings.length >= 2) {
        state.interns.push(internState("judge", "judge", "Group duplicate findings", null));
        await save();
        const ids = findings.map((finding) => finding.id);
        members = await askWith(ctx, "judge", judgePrompt(findings), "groups.json", (raw) => parseGroups(raw, ids));
      }
      const byId = new Map(findings.map((finding) => [finding.id, finding]));
      groups = members.map((list, index) => ({
        id: `g${index + 1}`,
        findings: list.map((id) => {
          const finding = byId.get(id);
          if (finding === undefined) throw new Error(`The judge grouped unknown finding ${id}`);
          return finding;
        }),
        confirmation: null,
      }));
    }

    state.options.confirmConcurrency = Math.min(groups.length, width);
    await phase("confirming");
    reproduced = groups.map((group, index) => ({ group, intern: internState(`c${index + 1}`, "confirm", lead(group).title, group.id), ran: false }));
    state.interns.push(...reproduced.map((entry) => entry.intern));
    await save();
    const confirming = limit(state.options.confirmConcurrency);
    await settle(reproduced.map((entry) => confirming((free) => reproduce(ctx, entry, target, opts.confirmMinutes, free))));
    if (opts.replay !== null && groups.every((group) => (group.confirmation?.result ?? null) === null)) {
      throw new Error(`No confirming intern recorded a result: ${reproduced.map(({ intern }) => `${intern.id} ${intern.status}: ${intern.detail}`).join("; ")}`);
    }

    await phase("reporting");
  };

  const ended = once(async (phase: RunPhase): Promise<string | null> => {
    if (opts.onEnd === undefined) return null;
    const env = { ...process.env, QA_INTERNS_RUN_DIR: runDir, QA_INTERNS_PHASE: phase };
    const code = await trackGroup(Bun.spawn(["sh", "-c", opts.onEnd], { env, stdin: "ignore", stdout: "inherit", stderr: "inherit", detached: true })).exited;
    return code === 0 ? null : `The --on-end command exited with ${code}`;
  });

  const run = async (): Promise<string> => {
    try {
      await phases();
    } catch (error) {
      if (!ctx.stopping) await finish(message(error));
      throw new Error(redact(message(error)));
    }
    const teardown = await finish(null);
    if (teardown !== null) throw new Error(redact(`Teardown of run ${runId} failed: ${teardown}`));
    return runDir;
  };

  return guard(
    ctx,
    async () => {
      const [result] = await Promise.allSettled([run()]);
      checkStopping(ctx);
      const hook = await ended(result.status === "fulfilled" ? "done" : "failed");
      if (result.status === "rejected") throw hook === null ? result.reason : new Error(`${message(result.reason)}; ${hook}`);
      if (hook !== null) throw new Error(hook);
      return result.value;
    },
    async () => {
      try {
        await finish(null);
        if (recorded !== undefined && !recorded.stopping) {
          record(recorded.error, recorded.teardowns);
          try {
            await write();
          } finally {
            await save();
          }
        }
      } finally {
        const hook = await ended("failed");
        if (hook !== null) process.stderr.write(`${hook}\n`);
      }
    },
    () => snapshot(null),
  );
}
