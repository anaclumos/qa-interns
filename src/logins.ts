import type { Subprocess } from "bun";
import { createHash } from "node:crypto";
import { closeSync, lstatSync, mkdirSync, openSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { z } from "zod";
import { providers } from "./providers.ts";
import { readJson, stateDir } from "./state.ts";
import { errorCode } from "./findings.ts";
import { redact } from "./secrets.ts";
import { capture, trackGroup } from "./target.ts";
import { providerNames, type Login, type Provider } from "./types.ts";

export const defaultLoginsPath = join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "qa-interns", "logins.json");

const example = `{"logins": [{"id": "claude-1", "provider": "claude", "store": "/absolute/path/to/login-store"}]}`;

const entrySchema = z.strictObject({
  id: z.string().min(1),
  provider: z.enum(providerNames),
  store: z
    .string()
    .refine(isAbsolute, { error: (issue) => `${JSON.stringify(issue.input)} is not an absolute path`, abort: true })
    .refine(isDirectory, { error: (issue) => `${JSON.stringify(issue.input)} is not an existing directory` })
    .optional(),
  seat: z.array(z.string().min(1)).min(1).optional(),
  quota: z.array(z.string().min(1)).min(1).optional(),
  concurrency: z.int().positive().default(1),
  model: z.string().min(1).optional(),
});

function isDirectory(path: string): boolean {
  return statSync(path, { throwIfNoEntry: false })?.isDirectory() === true;
}

function rawId(value: unknown): string | null {
  return z.object({ id: z.string() }).safeParse(value).data?.id ?? null;
}

type Store = { store: string; credential: string | null };

type Held = { store: string; where: string };

function credentialName(provider: Provider): string {
  return provider === "claude" ? ".credentials.json" : "auth.json";
}

function resolveStore(provider: Provider, store: string): Store {
  const credential = join(store, credentialName(provider));
  return { store: realpathSync(store), credential: statSync(credential, { throwIfNoEntry: false })?.isFile() === true ? realpathSync(credential) : null };
}

function claudeConfigDirs(): string[] {
  return [...new Set([join(homedir(), ".claude"), process.env.CLAUDE_CONFIG_DIR ?? ""].filter(isDirectory).map((dir) => realpathSync(dir)))];
}

function storeProblems(provider: Provider, path: string, found: Store, known: Held[]): string[] {
  const problems: string[] = [];
  if (found.store === "/") problems.push(`store ${path} is the root of the file system`);
  if (found.store !== resolve(path)) {
    problems.push(`store ${path} resolves through a symbolic link to ${found.store}; a runner can place a link in its own store to choose what another run mounts`);
  }
  for (const other of known) {
    if (other.store === found.store) {
      problems.push(`duplicate store ${path}, already used by ${other.where}; one store serves one process at a time`);
    } else if (found.store.startsWith(`${other.store}/`) || other.store.startsWith(`${found.store}/`)) {
      problems.push(`store ${path} contains or is inside the store of ${other.where}; a runner mounting one could read or change the other`);
    }
  }
  const name = credentialName(provider);
  if (found.credential === null) problems.push(`${provider} store ${path} has no ${name}`);
  else if (lstatSync(join(path, name)).isSymbolicLink()) {
    problems.push(`${join(path, name)} is a symbolic link; a runner can place a link in its own store to choose what another run mounts, so the credential is a regular file in the store`);
  }
  if (provider === "claude") {
    for (const config of claudeConfigDirs()) {
      if (config === found.store || config.startsWith(`${found.store}/`)) {
        problems.push(`claude store ${path} is or contains the Claude Code config directory ${config}; a runner can read and change every file in its store`);
      }
    }
  }
  return problems;
}

export async function loadLogins(file: string): Promise<Login[]> {
  const top = await readJson(file, z.object({ logins: z.array(z.unknown()) }), `No logins file at ${file}. Create it with this shape: ${example}`);
  if (top.logins.length === 0) throw new Error(`${file} lists no logins. Add at least one, for example ${example}`);

  const problems: string[] = [];
  const logins: Login[] = [];
  const firstIndex = new Map<string, number>();
  const known: Held[] = [];
  for (const [index, value] of top.logins.entries()) {
    const id = rawId(value);
    const where = id === null ? `logins[${index}]` : `logins[${index}] "${id}"`;
    if (id !== null) {
      const first = firstIndex.get(id);
      if (first === undefined) firstIndex.set(id, index);
      else problems.push(`${where}: duplicate id, already used by logins[${first}]`);
    }
    const parsed = entrySchema.safeParse(value);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        problems.push(issue.path.length === 0 ? `${where}: ${issue.message}` : `${where}: ${z.core.toDotPath(issue.path)}: ${issue.message}`);
      }
      continue;
    }
    const entry = parsed.data;
    if ((entry.store === undefined) === (entry.seat === undefined)) problems.push(`${where}: set exactly one of "store" or "seat"`);
    if (entry.store !== undefined) {
      const found = resolveStore(entry.provider, entry.store);
      for (const problem of storeProblems(entry.provider, entry.store, found, known)) problems.push(`${where}: ${problem}`);
      if (!known.some((other) => other.store === found.store)) known.push({ ...found, where: `logins[${index}]` });
    }
    if (entry.provider === "codex" && entry.store !== undefined) {
      if (entry.concurrency !== 1) {
        problems.push(
          `${where}: a codex store must have concurrency 1, because one auth.json copy serves one machine or one serialized job stream (https://learn.chatgpt.com/docs/auth/ci-cd-auth). Use a seat command to share a pool.`,
        );
      }
    }
    logins.push({
      id: entry.id,
      provider: entry.provider,
      store: entry.store ?? null,
      seat: entry.seat ?? null,
      quota: entry.quota ?? null,
      concurrency: entry.concurrency,
      model: entry.model ?? null,
    });
  }
  if (problems.length > 0) throw new Error(`${file} has problems:\n${problems.map((problem) => `  ${problem}`).join("\n")}`);
  return logins;
}

export type Lease = { login: Login; store: string; mounted: string; release(): void };

type Grant = { store: string; mounted: string; where: string };

type Slot = { login: Login; active: number; exhausted: boolean; store: Grant | null };

function mountSource(provider: Provider, store: string): string {
  const mounts = providers[provider].mounts(store);
  const [mount] = mounts;
  if (mount === undefined || mounts.length > 1) throw new Error(`A lease locks one mount source, but a ${provider} store mounts ${mounts.length}`);
  return mount.source;
}

function mountedPath(provider: Provider, store: string): string {
  return realpathSync(mountSource(provider, store));
}

const lockHeld = 75;
const quotaMs = 60_000;

export async function hasQuota(login: Login): Promise<boolean> {
  if (login.quota === null) return true;
  const { code, stderr } = await capture(login.quota, { timeout: quotaMs });
  if (code === 0 || code === 1) return code === 0;
  throw new Error(`The quota command of login ${login.id} exited with ${code}: ${redact(stderr).trim().slice(-2000)}`);
}

async function seatStore(command: string[], leasePid: number, intern: string): Promise<string | null> {
  const child = trackGroup(Bun.spawn(command, {
    env: { ...process.env, QA_INTERNS_LEASE_PID: String(leasePid), QA_INTERNS_INTERN: intern },
    stdout: "pipe",
    stderr: "inherit",
    detached: true,
  }));
  const signal = (name: "SIGTERM" | "SIGKILL") => {
    try {
      process.kill(-child.pid, name);
    } catch (error) {
      if (errorCode(error) !== "ESRCH") throw error;
    }
  };
  const term = setTimeout(() => {
    signal("SIGTERM");
    setTimeout(() => signal("SIGKILL"), 10_000);
  }, 60_000);
  const [stdout, exitCode] = await Promise.all([child.stdout.text(), child.exited]).finally(() => clearTimeout(term));
  const store = stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .at(-1);
  return exitCode === 0 && store !== undefined ? store : null;
}

export function flock(file: string, ...options: string[]): number | null {
  const fd = openSync(file, "a", 0o600);
  let code: number;
  try {
    code = Bun.spawnSync(["flock", ...options, "--conflict-exit-code", String(lockHeld), "3"], { stdio: ["ignore", "ignore", "inherit", fd] }).exitCode;
  } catch (error) {
    closeSync(fd);
    throw error;
  }
  if (code === 0) return fd;
  closeSync(fd);
  if (code !== lockHeld) throw new Error(`flock on ${file} exited with ${code}`);
  return null;
}

function ancestors(path: string): string[] {
  const found: string[] = [];
  for (let current = path; current !== "/"; ) {
    current = dirname(current);
    found.push(current);
  }
  return found;
}

function lock(mounted: string, slots: number): (() => void) | null {
  const dir = join(stateDir(), "locks");
  mkdirSync(dir, { recursive: true });
  const file = (path: string, kind: string) => join(dir, `${createHash("sha256").update(path).digest("hex")}-${kind}.lock`);
  const take = (lockFile: string, ...options: string[]) => {
    const fd = flock(lockFile, ...options);
    if (fd === null) throw new Error(`${lockFile} is locked by a process that does not hold ${join(dir, "acquire.lock")}`);
    return fd;
  };
  const above = ancestors(mounted);
  const held: number[] = [];
  const release = () => {
    for (const fd of held) closeSync(fd);
  };
  const mutex = take(join(dir, "acquire.lock"), "--exclusive");
  try {
    for (const test of [file(mounted, "under"), ...above.map((path) => file(path, "at"))]) {
      const fd = flock(test, "--exclusive", "--nonblock");
      if (fd === null) return null;
      closeSync(fd);
    }
    for (let slot = 0; slot < slots && held.length === 0; slot++) {
      const fd = flock(file(mounted, String(slot)), "--exclusive", "--nonblock");
      if (fd !== null) held.push(fd);
    }
    if (held.length === 0) return null;
    for (const share of [file(mounted, "at"), ...above.map((path) => file(path, "under"))]) held.push(take(share, "--shared", "--nonblock"));
  } catch (error) {
    release();
    throw error;
  } finally {
    closeSync(mutex);
  }
  return release;
}

export class Scheduler {
  private readonly slots: Slot[];
  private readonly exhaustedMounts = new Set<string>();
  private readonly live = new Set<Held>();
  private readonly refused = new Map<string, string[]>();

  constructor(logins: Login[]) {
    const known: Held[] = [];
    this.slots = logins.map((login) => {
      if (login.store === null) return { login, active: 0, exhausted: false, store: null };
      const found = resolveStore(login.provider, login.store);
      const problems = storeProblems(login.provider, login.store, found, known);
      if (problems.length > 0) throw new Error(`login ${login.id}: ${problems.join("; ")}`);
      const store = { store: found.store, mounted: mountedPath(login.provider, login.store), where: `login ${login.id}` };
      known.push(store);
      return { login, active: 0, exhausted: false, store };
    });
  }

  capacity(): number {
    return this.slots.filter((slot) => !slot.exhausted).reduce((sum, slot) => sum + slot.login.concurrency, 0);
  }

  providers(): Provider[] {
    return [...new Set(this.slots.filter((slot) => !slot.exhausted).map((slot) => slot.login.provider))];
  }

  async acquire(intern: string): Promise<Lease | null> {
    const tried = new Set<Slot>();
    const refused: string[] = [];
    this.refused.set(intern, refused);
    while (true) {
      const slot = this.next(tried);
      if (slot === undefined) return null;
      tried.add(slot);
      slot.active += 1;
      let lease: Lease | null = null;
      try {
        lease = await this.lease(slot, intern, refused);
      } finally {
        if (lease === null) slot.active -= 1;
      }
      if (lease !== null) return lease;
    }
  }

  exhaust(lease: Lease): void {
    const slot = this.slots.find((candidate) => candidate.login.id === lease.login.id);
    if (slot === undefined) throw new Error(`No login with id ${lease.login.id}`);
    if (slot.login.store === null) this.exhaustedMounts.add(lease.mounted);
    else slot.exhausted = true;
  }

  refusals(intern: string): string[] {
    return this.refused.get(intern) ?? [];
  }

  private async lease(slot: Slot, intern: string, refused: string[]): Promise<Lease | null> {
    const { login } = slot;
    if (!(await hasQuota(login))) {
      slot.exhausted = true;
      return null;
    }
    if (slot.store !== null) return this.grant(slot, slot.store, login.concurrency, null);
    if (login.seat === null) throw new Error(`Login ${login.id} has neither a store nor a seat command`);
    const keeper = Bun.spawn(["tail", `--pid=${process.pid}`, "-f", "/dev/null"], { stdin: "ignore", stdout: "ignore", stderr: "inherit" });
    const refuse = (problems: string[]) => refused.push(...problems.map((problem) => `seat store of login ${login.id}: ${problem}`));
    let lease: Lease | null = null;
    try {
      const path = await seatStore(login.seat, keeper.pid, intern);
      if (path !== null && !isAbsolute(path)) refuse(["the last line its command printed is not an absolute path"]);
      else if (path !== null && !isDirectory(path)) refuse([`store ${path} is not an existing directory`]);
      else if (path !== null) {
        const found = resolveStore(login.provider, path);
        const known = [...this.slots.flatMap((other) => other.store ?? []), ...this.live];
        const problems = storeProblems(login.provider, path, found, known);
        refuse(problems);
        if (problems.length === 0) {
          const mounted = mountedPath(login.provider, path);
          if (!this.exhaustedMounts.has(mounted)) lease = this.grant(slot, { store: found.store, mounted, where: `login ${login.id}` }, 1, keeper);
        }
      }
    } finally {
      if (lease === null) keeper.kill();
    }
    return lease;
  }

  private grant(slot: Slot, grant: Grant, slots: number, keeper: Subprocess | null): Lease | null {
    const unlock = lock(grant.mounted, slots);
    if (unlock === null) return null;
    try {
      const source = mountSource(slot.login.provider, grant.store);
      const resolved = realpathSync(source);
      if (source !== grant.mounted || resolved !== source) {
        throw new Error(`${grant.where}: store ${grant.store} changed after its check; ${source} resolves to ${resolved}, not ${grant.mounted}`);
      }
    } catch (error) {
      unlock();
      throw error;
    }
    const entry = { ...grant };
    this.live.add(entry);
    let released = false;
    return {
      login: slot.login,
      store: grant.store,
      mounted: grant.mounted,
      release: () => {
        if (released) return;
        released = true;
        slot.active -= 1;
        this.live.delete(entry);
        keeper?.kill();
        unlock();
      },
    };
  }

  private next(tried: Set<Slot>): Slot | undefined {
    return this.slots.find((slot) => !slot.exhausted && !tried.has(slot) && slot.active < slot.login.concurrency);
  }
}
