import type { Subprocess } from "bun";
import { createHash } from "node:crypto";
import { closeSync, lstatSync, mkdirSync, openSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { z } from "zod";
import { providers } from "./providers.ts";
import { readJson, stateDir } from "./state.ts";
import { errorCode } from "./findings.ts";
import { trackGroup } from "./target.ts";
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

type Held = Store & { where: string };

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
  let same = false;
  for (const other of known) {
    if (other.store === found.store) {
      same = true;
      problems.push(`duplicate store ${path}, already used by ${other.where}; one store serves one process at a time`);
    } else if (found.store.startsWith(`${other.store}/`) || other.store.startsWith(`${found.store}/`)) {
      problems.push(`store ${path} contains or is inside the store of ${other.where}; a runner mounting one could read or change the other`);
    }
  }
  const name = credentialName(provider);
  if (found.credential === null) problems.push(`${provider} store ${path} has no ${name}`);
  else if (!same) {
    const first = known.find((other) => other.credential === found.credential);
    if (first !== undefined) problems.push(`${join(path, name)} is the same file as the credential of ${first.where}; one credential serves one process at a time`);
  }
  if (found.credential !== null && mountedPath(provider, path) === found.store && lstatSync(join(path, name)).isSymbolicLink()) {
    problems.push(`${join(path, name)} is a symbolic link; a runner mounts only the store, so the credential is a regular file in it`);
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
      concurrency: entry.concurrency,
      model: entry.model ?? null,
    });
  }
  if (problems.length > 0) throw new Error(`${file} has problems:\n${problems.map((problem) => `  ${problem}`).join("\n")}`);
  return logins;
}

export type Lease = { login: Login; store: string; mounted: string; release(): void };

type Grant = { store: string; credential: string; mounted: string; where: string };

type Slot = { login: Login; active: number; exhausted: boolean; store: Grant | null };

function mountedPath(provider: Provider, store: string): string {
  const mounts = providers[provider].mounts(store);
  const [mount] = mounts;
  if (mount === undefined || mounts.length > 1) throw new Error(`A lease locks one mount source, but a ${provider} store mounts ${mounts.length}`);
  return realpathSync(mount.source);
}

const lockHeld = 75;

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
  return exitCode === 0 && store !== undefined && isAbsolute(store) && isDirectory(store) ? store : null;
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

function locksDir(): string {
  const dir = join(stateDir(), "locks");
  mkdirSync(dir, { recursive: true });
  return dir;
}

function lockFile(dir: string, path: string, kind: string): string {
  return join(dir, `${createHash("sha256").update(path).digest("hex")}-${kind}.lock`);
}

function take(dir: string, file: string, ...options: string[]): number {
  const fd = flock(file, ...options);
  if (fd === null) throw new Error(`${file} is locked by a process that does not hold ${join(dir, "acquire.lock")}`);
  return fd;
}

function exclusive<T>(dir: string, body: () => T): T {
  const mutex = take(dir, join(dir, "acquire.lock"), "--exclusive");
  try {
    return body();
  } finally {
    closeSync(mutex);
  }
}

function claim(key: string): () => void {
  const dir = locksDir();
  const fd = exclusive(dir, () => take(dir, lockFile(dir, key, "leased"), "--shared", "--nonblock"));
  return () => closeSync(fd);
}

function claimed(key: string): boolean {
  const dir = locksDir();
  return exclusive(dir, () => {
    const fd = flock(lockFile(dir, key, "leased"), "--exclusive", "--nonblock");
    if (fd !== null) closeSync(fd);
    return fd === null;
  });
}

function slotLock(dir: string, mounted: string, slots: number): number | null {
  for (const test of [lockFile(dir, mounted, "under"), ...ancestors(mounted).map((path) => lockFile(dir, path, "at"))]) {
    const fd = flock(test, "--exclusive", "--nonblock");
    if (fd === null) return null;
    closeSync(fd);
  }
  for (let slot = 0; slot < slots; slot++) {
    const fd = flock(lockFile(dir, mounted, String(slot)), "--exclusive", "--nonblock");
    if (fd !== null) return fd;
  }
  return null;
}

function blocked(mounted: string, slots: number): boolean {
  const dir = locksDir();
  return exclusive(dir, () => {
    const fd = slotLock(dir, mounted, slots);
    if (fd !== null) closeSync(fd);
    return fd === null;
  });
}

function lock(mounted: string, slots: number): (() => void) | null {
  const dir = locksDir();
  return exclusive(dir, () => {
    const fd = slotLock(dir, mounted, slots);
    if (fd === null) return null;
    const held = [fd];
    const release = () => {
      for (const each of held) closeSync(each);
    };
    try {
      for (const share of [lockFile(dir, mounted, "at"), ...ancestors(mounted).map((path) => lockFile(dir, path, "under"))]) held.push(take(dir, share, "--shared", "--nonblock"));
    } catch (error) {
      release();
      throw error;
    }
    return release;
  });
}

export class Scheduler {
  private readonly slots: Slot[];
  private readonly used: Record<Provider, number> = { claude: 0, codex: 0, cursor: 0, grok: 0 };
  private readonly exhaustedMounts = new Set<string>();
  private readonly live = new Set<Held>();

  constructor(logins: Login[]) {
    this.slots = logins.map((login) => {
      if (login.store === null) return { login, active: 0, exhausted: false, store: null };
      const found = resolveStore(login.provider, login.store);
      if (found.credential === null) throw new Error(`${login.provider} store ${login.store} has no ${credentialName(login.provider)}`);
      const store = { store: found.store, credential: found.credential, mounted: mountedPath(login.provider, login.store), where: `login ${login.id}` };
      return { login, active: 0, exhausted: false, store };
    });
  }

  leased(): boolean {
    return this.slots.some((slot) => !slot.exhausted && (slot.store === null ? claimed(JSON.stringify(slot.login.seat)) : blocked(slot.store.mounted, slot.login.concurrency)));
  }

  capacity(): number {
    return this.slots.filter((slot) => !slot.exhausted).reduce((sum, slot) => sum + slot.login.concurrency, 0);
  }

  providers(): Provider[] {
    return [...new Set(this.slots.filter((slot) => !slot.exhausted).map((slot) => slot.login.provider))];
  }

  async acquire(intern: string, avoid: Provider[]): Promise<Lease | null> {
    const tried = new Set<Slot>();
    while (true) {
      const slot = this.next(avoid, tried);
      if (slot === undefined) return null;
      tried.add(slot);
      const unclaim = slot.store === null ? claim(JSON.stringify(slot.login.seat)) : () => {};
      slot.active += 1;
      let lease: Lease | null = null;
      try {
        lease = await this.lease(slot, intern, unclaim);
      } finally {
        if (lease === null) {
          slot.active -= 1;
          unclaim();
        }
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

  private async lease(slot: Slot, intern: string, unclaim: () => void): Promise<Lease | null> {
    const { login } = slot;
    if (slot.store !== null) return this.grant(slot, slot.store, login.concurrency, null, unclaim);
    if (login.seat === null) throw new Error(`Login ${login.id} has neither a store nor a seat command`);
    const keeper = Bun.spawn(["tail", `--pid=${process.pid}`, "-f", "/dev/null"], { stdin: "ignore", stdout: "ignore", stderr: "inherit" });
    let lease: Lease | null = null;
    try {
      const path = await seatStore(login.seat, keeper.pid, intern);
      if (path !== null) {
        const found = resolveStore(login.provider, path);
        const known = [...this.slots.flatMap((other) => other.store ?? []), ...this.live];
        if (found.credential !== null && storeProblems(login.provider, path, found, known).length === 0) {
          const mounted = mountedPath(login.provider, path);
          if (!this.exhaustedMounts.has(mounted)) lease = this.grant(slot, { store: found.store, credential: found.credential, mounted, where: `login ${login.id}` }, 1, keeper, unclaim);
        }
      }
    } finally {
      if (lease === null) keeper.kill();
    }
    return lease;
  }

  private grant(slot: Slot, grant: Grant, slots: number, keeper: Subprocess | null, unclaim: () => void): Lease | null {
    const unlock = lock(grant.mounted, slots);
    if (unlock === null) return null;
    this.used[slot.login.provider] += 1;
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
        unclaim();
      },
    };
  }

  private next(avoid: Provider[], tried: Set<Slot>): Slot | undefined {
    const spare = (slot: Slot) => slot.login.concurrency - slot.active;
    return this.slots
      .filter((slot) => !slot.exhausted && !tried.has(slot) && spare(slot) > 0)
      .sort(
        (a, b) =>
          Number(avoid.includes(a.login.provider)) - Number(avoid.includes(b.login.provider)) ||
          this.used[a.login.provider] - this.used[b.login.provider] ||
          spare(b) - spare(a),
      )[0];
  }
}
