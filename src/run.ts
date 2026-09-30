import { mkdir, rm } from "node:fs/promises";
import { freemem } from "node:os";
import { join } from "node:path";
import { AgentError, openSession, type Session } from "./acp.ts";
import {
  buildImages,
  containerStats,
  environmentMemory,
  freeSlot,
  freeSlots,
  networkRange,
  readRelayLogs,
  removeCopies,
  runnerEnv,
  saveDisks,
  startEnvironment,
  stopEnvironment,
  stopProject,
  stopRun,
  watchOut,
  writeChromePolicy,
  type Environment,
  type EnvironmentSpec,
  type HeldSlot,
} from "./environment.ts";
import { message, oneLine, outDir, parseGroups, readAgentFile, readConfirmation, readFindings, stripControl } from "./findings.ts";
import { loadLogins, Scheduler, type Lease } from "./logins.ts";
import { confirmPrompt, continuePrompt, correctionPrompt, deck, internPrompt, judgePrompt, type PromptEnvironment } from "./prompt.ts";
import { providers } from "./providers.ts";
import { lead, renderReplay, renderReport, writeTickets } from "./report.ts";
import { forgetSecrets, hasSecrets, redact, redactFiles, redactJson } from "./secrets.ts";
import { newRunId, processStart, runDirFor, runsDir, writeState } from "./state.ts";
import { execute, exportTree, killCommands, loadTarget, resolveTarget, trackGroup, type Target, type TargetRef } from "./target.ts";
import type { Confirmation, EnvironmentStats, Finding, FindingEnvironment, Group, InternState, Provider, Rejected, Replay, RunPhase, RunState } from "./types.ts";

export type RunOptions = {
  dir: string;
  rev: string;
  dirty: boolean;
  interns: number;
  minutes: number;
  confirmMinutes: number;
  loginsFile: string;
  replay: Replay | null;
  onEnd?: string;
  runnerImage(): Promise<string>;
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
  prompt: string;
  file: string;
  parse(raw: string): unknown;
};

type Turn = Awaited<ReturnType<Session["prompt"]>>;
type Limit = <T>(task: () => Promise<T>) => Promise<T>;
type Note = (text: string) => Promise<void>;
type Work<T> = (session: Session, attempt: number, env: Environment, provider: Provider, note: Note) => Promise<T>;
type Outcome<T> = { status: "done"; value: T } | { status: "limited" } | { status: "failed"; error: unknown };

type Context = {
  runId: string;
  runDir: string;
  runnerImage: string;
  scheduler: Scheduler;
  images: Record<string, string>;
  sessions: Set<Session>;
  startups: Limit;
  teardowns: string[];
  environments: EnvironmentStats[];
  held: number;
  waiting: (() => void)[];
  stopping: boolean;
  update(id: string, patch: Partial<InternState>): Promise<void>;
};

const signals = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
const minute = 60_000;
const askMinutes = 10;
const settleMs = 60_000;
const stopWaitMs = 30_000;
const gib = 1024 ** 3;
const noLogin = "no login has spare capacity";
const copyName = "up";

function now(): string {
  return new Date().toISOString();
}

function limit(size: number): Limit {
  let active = 0;
  const queue: (() => void)[] = [];
  return async <T>(task: () => Promise<T>): Promise<T> => {
    if (active < size) active += 1;
    else await new Promise<void>((resolve) => queue.push(resolve));
    try {
      return await task();
    } finally {
      const next = queue.shift();
      if (next === undefined) active -= 1;
      else next();
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

function context(runId: string, runDir: string, runnerImage: string, scheduler: Scheduler, update: Context["update"]): Context {
  return {
    runId,
    runDir,
    runnerImage,
    scheduler,
    images: {},
    sessions: new Set(),
    startups: limit(4),
    teardowns: [],
    environments: [],
    held: 0,
    waiting: [],
    stopping: false,
    update,
  };
}

async function acquire(ctx: Context, id: string, avoid: Provider[]): Promise<Lease | null> {
  for (;;) {
    checkStopping(ctx);
    const lease = await ctx.scheduler.acquire(id, avoid);
    if (lease !== null) {
      ctx.held += 1;
      let released = false;
      return {
        ...lease,
        release: () => {
          if (released) return;
          released = true;
          lease.release();
          ctx.held -= 1;
          for (const wake of ctx.waiting.splice(0)) wake();
        },
      };
    }
    if (ctx.held === 0 || ctx.scheduler.capacity() === 0) return null;
    await new Promise<void>((resolve) => ctx.waiting.push(resolve));
  }
}

function environmentSpec(ctx: Context, name: string, slot: number, target: Target | null, lease: Lease, attempt: number): EnvironmentSpec {
  const provider = providers[lease.login.provider];
  return {
    runId: ctx.runId,
    runDir: ctx.runDir,
    name,
    slot,
    target,
    images: target === null ? {} : ctx.images,
    runner: {
      image: ctx.runnerImage,
      out: join(ctx.runDir, outDir(name, attempt)),
      env: { ...runnerEnv(target === null ? {} : target.settings.urls), ...provider.env },
      mounts: provider.mounts(lease.store),
      files: provider.files,
      tmpfs: provider.tmpfs,
    },
    egress: provider.egress,
  };
}

async function attempt<T>(ctx: Context, id: string, count: number, env: Environment, lease: Lease, work: Work<T>, note: Note): Promise<{ value: T } | AgentError> {
  const provider = providers[lease.login.provider];
  let session: Session | undefined;
  const done = new AbortController();
  try {
    session = await openSession({
      container: env.runner,
      provider,
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
    const result = await Promise.race([work(session, count, env, lease.login.provider, live).then((value) => ({ value })), watchOut(env.out, done.signal)]);
    if (typeof result !== "string") return result;
    stopped = true;
    await execute(["docker", "kill", env.runner]);
    throw new Error(`${result}, so its runner was stopped`);
  } catch (error) {
    if (error instanceof AgentError && provider.isLoginFailure(error)) return error;
    throw error;
  } finally {
    done.abort();
    if (session !== undefined) {
      ctx.sessions.delete(session);
      await session.close();
    }
  }
}

async function leased<T>(ctx: Context, id: string, target: Target | null, avoid: Provider[], work: Work<T>, note: Note): Promise<{ value: T } | null> {
  let lease = await acquire(ctx, id, avoid);
  if (lease === null) return null;
  const project = `qa-${ctx.runId}-${id}`;
  let slot: HeldSlot | undefined;
  let started = false;
  let unread = null as EnvironmentStats | null;
  const teardown = async () => {
    const environment = unread;
    unread = null;
    try {
      if (environment !== null) environment.containers = await containerStats(project);
    } finally {
      await stopEnvironment(ctx.runDir, id, project, ctx.runnerImage);
    }
  };
  try {
    await ctx.update(id, { status: "starting", provider: lease.login.provider, login: lease.login.id, project, startedAt: now() });
    for (let count = 1; ; count += 1) {
      const current = lease;
      const env = await ctx.startups(async () => {
        checkStopping(ctx);
        slot = await freeSlot();
        const environment: EnvironmentStats = { intern: id, attempt: count, startedAt: now(), readyAt: null, containers: null };
        ctx.environments.push(environment);
        started = true;
        unread = environment;
        return startEnvironment(environmentSpec(ctx, id, slot.slot, target, current, count), () => {
          environment.readyAt = now();
        });
      });
      const outcome = await attempt(ctx, id, count, env, lease, work, note);
      if (!(outcome instanceof AgentError)) return outcome;
      ctx.scheduler.exhaust(lease);
      await teardown();
      started = false;
      slot?.release();
      slot = undefined;
      lease.release();
      const next = await acquire(ctx, id, avoid);
      if (next === null) {
        await note(`login ${lease.login.id} failed with ${outcome.code}: ${outcome.message}`);
        return null;
      }
      await note(`moved from ${lease.login.id} to ${next.login.id} after a login failure (${outcome.code}: ${outcome.message})`);
      lease = next;
      await ctx.update(id, { status: "starting", provider: lease.login.provider, login: lease.login.id, model: null });
    }
  } finally {
    try {
      if (started) await teardown();
    } catch (error) {
      ctx.teardowns.push(`${id}: ${message(error)}`);
      await note(`teardown failed: ${message(error)}`);
    } finally {
      slot?.release();
      lease.release();
    }
  }
}

async function agentTask<T>(ctx: Context, id: string, target: Target | null, avoid: Provider[], work: Work<T>): Promise<Outcome<T>> {
  const notes: string[] = [];
  const detail = () => (notes.length === 0 ? null : stripControl(notes.join("; ")));
  const note = async (text: string) => {
    notes.push(text);
    await ctx.update(id, { detail: detail() });
  };
  let outcome: Outcome<T>;
  try {
    const result = await leased(ctx, id, target, avoid, work, note);
    outcome = result === null ? { status: "limited" } : { status: "done", value: result.value };
    if (result === null) notes.push(noLogin);
  } catch (error) {
    notes.push(ctx.stopping ? "interrupted" : message(error));
    outcome = { status: "failed", error };
  }
  await ctx.update(id, { status: outcome.status, detail: detail(), endedAt: now() });
  return outcome;
}

async function turnUntil(session: Session, text: string, deadline: number): Promise<Turn | null> {
  if (Date.now() >= deadline) return null;
  const turn = session.prompt(text);
  const result = await within(turn, deadline - Date.now());
  if (result !== null) return result;
  const settled = turn.then(
    () => undefined,
    () => undefined,
  );
  await session.cancel();
  await within(settled, settleMs);
  return null;
}

async function converse(session: Session, first: string, deadline: number, next: (turn: Turn, idle: boolean) => Promise<string | null>): Promise<boolean> {
  let text: string | null = first;
  let quiet = false;
  while (text !== null) {
    const turn = await turnUntil(session, text, deadline);
    if (turn === null) return false;
    const idle = quiet && turn.toolCalls === 0;
    quiet = turn.toolCalls === 0;
    text = await next(turn, idle);
  }
  return true;
}

function minutesLeft(deadline: number): number {
  return Math.max(0, Math.ceil((deadline - Date.now()) / minute));
}

function promptEnvironment(target: Target, env: Environment, minutes: number): PromptEnvironment {
  return { urls: target.settings.urls, seed: env.seed, minutes, offLimits: target.settings.offLimits };
}

async function askWith<T>(ctx: Context, id: string, prompt: string, file: string, parse: (raw: string) => T): Promise<T> {
  const outcome = await agentTask(ctx, id, null, [], async (session, attempt) => {
    const path = join(ctx.runDir, outDir(id, attempt), file);
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
    if (parsed === null) throw new Error(`${id} wrote no valid /qa/out/${file} within ${askMinutes} minutes`);
    return parsed.value;
  });
  if (outcome.status === "failed") throw outcome.error;
  if (outcome.status === "limited") throw new Error(`No login has spare capacity for ${id}`);
  return outcome.value;
}

async function explore(ctx: Context, intern: InternState, target: Target, minutes: number): Promise<{ outcome: Outcome<void>; findings: Finding[]; rejected: Rejected[] }> {
  const attempts: { attempt: number; environment: FindingEnvironment }[] = [];
  const outcome = await agentTask(ctx, intern.id, target, [], async (session, attempt, env, provider, note) => {
    const environment = { commit: target.commit, dirty: target.dirty, environment: env.project, provider, model: session.model };
    attempts.push({ attempt, environment });
    const start = Date.now();
    const deadline = start + minutes * minute;
    await converse(session, internPrompt(intern.charter, promptEnvironment(target, env, minutes), target.settings.knownGaps), deadline, async (turn, idle) => {
      if (idle) {
        await note(`stopped at minute ${Math.floor((Date.now() - start) / minute)}: "${turn.lastMessage}"`);
        return null;
      }
      const { rejected } = await readFindings(ctx.runDir, intern.id, attempt, environment);
      return continuePrompt(minutesLeft(deadline), rejected, outDir(intern.id, attempt));
    });
  });
  const results = await Promise.all(attempts.map((entry) => readFindings(ctx.runDir, intern.id, entry.attempt, entry.environment)));
  const findings = results.flatMap((result) => result.findings);
  const rejected = results.flatMap((result) => result.rejected);
  await ctx.update(intern.id, { findings: findings.length, rejected: rejected.length });
  return { outcome, findings, rejected };
}

async function reproduce(ctx: Context, intern: InternState, group: Group, target: Target, minutes: number): Promise<void> {
  const finding = lead(group);
  const avoid = [...new Set(group.findings.map((entry) => entry.environment.provider))];
  const check = async (attempt: number): Promise<{ result: Confirmation | null; error: string | null }> => {
    try {
      return { result: await readConfirmation(ctx.runDir, intern.id, attempt), error: null };
    } catch (error) {
      return { result: null, error: message(error) };
    }
  };
  const attempts: { attempt: number; provider: Provider }[] = [];
  const outcome = await agentTask(ctx, intern.id, target, avoid, async (session, attempt, env, provider, note) => {
    attempts.push({ attempt, provider });
    const out = outDir(intern.id, attempt);
    const file = join(ctx.runDir, out, "confirmation.json");
    const deadline = Date.now() + minutes * minute;
    let answer: { result: Confirmation | null; error: string | null } = { result: null, error: "no confirmation.json written" };
    let corrected = false;
    await converse(session, confirmPrompt(finding, promptEnvironment(target, env, minutes)), deadline, async (_turn, idle) => {
      if (!(await Bun.file(file).exists())) return idle ? null : continuePrompt(minutesLeft(deadline), [], out);
      answer = await check(attempt);
      if (answer.error === null || corrected) return null;
      corrected = true;
      return correctionPrompt("/qa/out/confirmation.json", answer.error);
    });
    if (answer.result === null && (await Bun.file(file).exists())) answer = await check(attempt);
    await note(answer.result === null ? `confirmation failed: ${answer.error}` : answer.result.reproduced ? "reproduced" : "did not reproduce");
    return answer;
  });
  const answer = outcome.status === "done" ? outcome.value : { result: null, error: outcome.status === "limited" ? noLogin : message(outcome.error) };
  let confirmation = { intern: intern.id, provider: intern.provider, ...answer };
  for (const entry of attempts.toReversed()) {
    if (confirmation.result !== null) break;
    const earlier = await check(entry.attempt);
    if (earlier.result !== null) confirmation = { intern: intern.id, provider: entry.provider, ...earlier };
  }
  group.confirmation = confirmation;
}

function internState(id: string, role: InternState["role"], charter: string, group: string | null): InternState {
  return {
    id,
    role,
    charter,
    group,
    provider: null,
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
  if (intern.status === "starting" || intern.status === "testing") return `${intern.id} ${intern.status} on ${intern.login} (${intern.provider})`;
  if (intern.detail === null) return `${intern.id} ${intern.status}`;
  return `${intern.id} ${intern.status}: ${oneLine(redact(intern.detail)).slice(0, 300)}`;
}

function once<A extends unknown[], R>(fn: (...args: A) => Promise<R>): (...args: A) => Promise<R> {
  let result: Promise<R> | undefined;
  return (...args) => (result ??= fn(...args));
}

async function stop(ctx: Context, running: Promise<unknown> | undefined): Promise<void> {
  ctx.stopping = true;
  killCommands();
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

async function guard<T>(ctx: Context, body: () => Promise<T>, interrupted: () => Promise<void>): Promise<T> {
  let running: Promise<T> | undefined;
  let signalled = false;
  const handler = () => {
    if (signalled) return;
    signalled = true;
    process.stderr.write("Interrupted. Closing sessions and tearing down.\n");
    stop(ctx, running)
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
  try {
    running = body();
    const [result] = await Promise.allSettled([running]);
    if (ctx.stopping) return await new Promise<never>(() => {});
    if (result.status === "rejected") throw result.reason;
    return result.value;
  } finally {
    for (const signal of signals) process.off(signal, handler);
    forgetSecrets();
  }
}

export async function ask(opts: AskOptions): Promise<unknown> {
  const scheduler = new Scheduler(await loadLogins(opts.loginsFile));
  const ctx = context(opts.runId, opts.runDir, opts.runnerImage, scheduler, async () => {});
  const project = `qa-${opts.runId}-${opts.name}`;
  const finish = once(async (): Promise<string | null> => {
    const teardowns = [...ctx.teardowns];
    try {
      await stopProject(project, join(opts.runDir, "interns", opts.name));
      await saveDisks(opts.runDir, opts.name, project, opts.runnerImage);
    } catch (reason) {
      teardowns.push(message(reason));
    }
    return teardowns.length === 0 ? null : `Teardown of ${project} failed: ${teardowns.join("; ")}`;
  });
  return guard(
    ctx,
    async () => {
      const [result] = await Promise.allSettled([askWith(ctx, opts.name, opts.prompt, opts.file, opts.parse)]);
      const teardown = await finish();
      if (teardown !== null) throw new Error(result.status === "rejected" ? `${message(result.reason)}; ${teardown}` : teardown);
      if (result.status === "rejected") throw result.reason;
      return result.value;
    },
    async () => {
      const teardown = await finish();
      if (teardown !== null) throw new Error(teardown);
    },
  );
}

async function newRun(ref: TargetRef, options: RunState["options"], print: (line: string) => void) {
  const runId = newRunId();
  const runDir = runDirFor(runId);
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
  return { runId, runDir, state, save };
}

export async function startCopy(opts: CopyOptions): Promise<string> {
  const ref = await resolveTarget(opts.dir, opts.rev, false);
  const { runId, runDir, state, save } = await newRun(ref, { interns: 0, minutes: 0, confirmMinutes: 0, concurrency: 0 }, opts.print);
  const ctx = context(runId, runDir, "", new Scheduler([]), async () => {});
  const phase = async (next: RunPhase) => {
    checkStopping(ctx);
    state.phase = next;
    opts.print(`phase ${next}`);
    await save();
  };
  const finish = once(async (error: string): Promise<void> => {
    const problems = [error];
    for (const step of [() => stopRun(runDir, runId), () => removeCopies(runDir, runId, ctx.runnerImage)]) {
      try {
        await step();
      } catch (reason) {
        problems.push(`teardown failed: ${message(reason)}`);
      }
    }
    state.phase = "failed";
    state.error = stripControl(problems.join("; "));
    state.endedAt = now();
    await save();
  });
  return guard(
    ctx,
    async () => {
      let slot: HeldSlot | undefined;
      try {
        ctx.runnerImage = await opts.runnerImage();
        const source = join(runDir, "source");
        await exportTree(ref, source);
        const target = await loadTarget(ref, source);
        await writeChromePolicy(runDir, target.settings.urls);
        await phase("building");
        const images = await buildImages(runId, target, source);
        await phase("starting");
        slot = await freeSlot();
        const env = await startEnvironment({
          runId,
          runDir,
          name: copyName,
          slot: slot.slot,
          target,
          images,
          runner: { image: ctx.runnerImage, out: join(runDir, outDir(copyName, 1)), env: runnerEnv(target.settings.urls), mounts: [], files: [], tmpfs: [] },
          egress: [],
        });
        await phase("up");
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
    () => finish("interrupted"),
  );
}

export async function runQa(opts: RunOptions): Promise<string> {
  const scheduler = new Scheduler(await loadLogins(opts.loginsFile));
  const ref = await resolveTarget(opts.dir, opts.rev, opts.dirty);
  const options = { interns: opts.interns, minutes: opts.minutes, confirmMinutes: opts.confirmMinutes, concurrency: 0 };
  const { runId, runDir, state, save } = await newRun(ref, options, opts.print);

  const ctx = context(runId, runDir, "", scheduler, async (id, patch) => {
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

  let findings: Finding[] = [];
  let rejected: Rejected[] = [];
  let groups: Group[] | null = opts.replay?.groups ?? null;
  let egress: string[] = [];

  const finish = once(async (error: string | null): Promise<string | null> => {
    const teardowns = [...ctx.teardowns];
    for (const step of [() => stopRun(runDir, runId), () => removeCopies(runDir, runId, ctx.runnerImage)]) {
      try {
        await step();
      } catch (reason) {
        teardowns.push(message(reason));
      }
    }
    const dirs = [join(runDir, "envs"), join(runDir, "interns")];
    if (teardowns.length > ctx.teardowns.length) {
      if (hasSecrets()) teardowns.push(`secret values stay in the files under ${dirs.join(" and ")}`);
    } else {
      try {
        await redactFiles(dirs);
      } catch (reason) {
        teardowns.push(`secret values stay in the files under ${dirs.join(" and ")}: ${message(reason)}`);
      }
    }
    const problems = [error, ...teardowns.map((teardown) => `teardown failed: ${teardown}`)].filter((entry) => entry !== null);
    state.phase = problems.length === 0 ? "done" : "failed";
    state.error = problems.length === 0 ? null : stripControl(problems.join("; "));
    state.endedAt = now();
    const singles = findings.map((finding, index) => ({ id: `g${index + 1}`, findings: [finding], confirmation: null }));
    const logs = await Promise.all(state.interns.map(async (intern) => (await readRelayLogs(join(runDir, "interns", intern.id))).map((records) => ({ intern: intern.id, records }))));
    const traffic = redactJson({ hosts: egress, relays: logs.flat() });
    const environments = redactJson(ctx.environments);
    const report =
      opts.replay === null
        ? renderReport(redactJson(state), redactJson(groups ?? singles), redactJson(rejected), traffic, environments)
        : { ...renderReplay(redactJson(state), redactJson(opts.replay), traffic, environments), tickets: [] };
    await Bun.write(join(runDir, "report.md"), report.markdown);
    await Bun.write(join(runDir, "findings.json"), `${JSON.stringify(report.json, null, 2)}\n`);
    await writeTickets(runDir, report.tickets);
    await save();
    return teardowns.length === 0 ? null : teardowns.join("; ");
  });

  const phases = async () => {
    const source = join(runDir, "source");
    await exportTree(ref, source);
    ctx.runnerImage = await opts.runnerImage();
    const target = await loadTarget(ref, source);
    egress = target.settings.egress;
    const memory = environmentMemory(target);
    const free = freemem();
    const slots = await freeSlots();
    if (slots === 0) throw new Error(`No free network slot: every /23 block of QA_INTERNS_SUBNET ${networkRange().subnet} overlaps a Docker network or a host route`);
    const concurrency = Math.min(opts.replay?.groups.length ?? opts.interns, Math.floor(free / memory), scheduler.capacity(), slots);
    if (concurrency < 1) {
      throw new Error(`Free memory is ${(free / gib).toFixed(1)} GiB, and one environment of this target reserves ${(memory / gib).toFixed(1)} GiB`);
    }
    state.options.concurrency = concurrency;
    const cards = deck(target.settings.focus);
    state.interns = Array.from({ length: opts.interns }, (_, index) => {
      const charter = cards[index % cards.length];
      if (charter === undefined) throw new Error("The charter deck is empty");
      return internState(`i${index + 1}`, "intern", charter, null);
    });
    await writeChromePolicy(runDir, target.settings.urls);
    await save();

    await phase("building");
    ctx.images = await buildImages(runId, target, source);
    const running = limit(concurrency);

    if (groups === null) {
      await phase("testing");
      const results = await settle(state.interns.map((intern) => running(() => explore(ctx, intern, target, opts.minutes))));
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

    await phase("confirming");
    const confirmations = groups.map((group, index) => ({ group, intern: internState(`c${index + 1}`, "confirm", lead(group).title, group.id) }));
    state.interns.push(...confirmations.map((entry) => entry.intern));
    await save();
    await settle(confirmations.map(({ group, intern }) => running(() => reproduce(ctx, intern, group, target, opts.confirmMinutes))));
    if (opts.replay !== null && groups.every((group) => (group.confirmation?.result ?? null) === null)) {
      throw new Error(`No confirming intern recorded a result: ${confirmations.map(({ intern }) => `${intern.id} ${intern.status}: ${intern.detail}`).join("; ")}`);
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
        await finish("interrupted");
      } finally {
        const hook = await ended("failed");
        if (hook !== null) process.stderr.write(`${hook}\n`);
      }
    },
  );
}
