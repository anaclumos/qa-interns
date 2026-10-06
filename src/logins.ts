import type { Subprocess } from "bun";
import { createHash } from "node:crypto";
import { closeSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, watch, writeFileSync, type Stats } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { z } from "zod";
import { opencodeAuthRule, opencodeLogin, providers } from "./providers.ts";
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

const unreachable = new Set(["ENOENT", "ENOTDIR", "ENAMETOOLONG", "ELOOP", "EACCES"]);

function stat(path: string): Stats | null {
  try {
    return statSync(path);
  } catch (error) {
    if (unreachable.has(errorCode(error) ?? "")) return null;
    throw error;
  }
}

function isDirectory(path: string): boolean {
  return stat(path)?.isDirectory() === true;
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
  return { store: realpathSync(store), credential: stat(credential)?.isFile() === true ? realpathSync(credential) : null };
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
      problems.push(`duplicate store ${path}, already used by ${other.where}; one store serves one login`);
    } else if (found.store.startsWith(`${other.store}/`) || other.store.startsWith(`${found.store}/`)) {
      problems.push(`store ${path} contains or is inside the store of ${other.where}; a runner mounting one could read or change the other`);
    }
  }
  const name = credentialName(provider);
  if (found.credential === null) problems.push(`${provider} store ${path} has no ${name}`);
  else if (lstatSync(join(path, name)).isSymbolicLink()) {
    problems.push(`${join(path, name)} is a symbolic link; a runner can place a link in its own store to choose what another run mounts, so the credential is a regular file in the store`);
  } else if (provider === "opencode" && opencodeLogin(found.credential) === null) {
    problems.push(
      `${join(path, name)} ${opencodeAuthRule}; a runner can read every credential in it, and OpenCode loads remote config, which can add MCP servers, for a wellknown entry`,
    );
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

function locksDir(): string {
  const dir = join(stateDir(), "locks");
  mkdirSync(dir, { recursive: true });
  return dir;
}

const releasedFile = "released";

export function watchReleases(wake: () => void): () => void {
  const watcher = watch(locksDir(), (_event, name) => {
    if (name === releasedFile) wake();
  });
  return () => watcher.close();
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

function slotLock(dir: string, mounted: string, provider: Provider, slots: number): number | null {
  const others = providerNames.filter((other) => other !== provider).map((other) => lockFile(dir, mounted, other));
  for (const test of [lockFile(dir, mounted, "under"), ...ancestors(mounted).map((path) => lockFile(dir, path, "at")), ...others]) {
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

function blocked(mounted: string, provider: Provider, slots: number): boolean {
  const dir = locksDir();
  return exclusive(dir, () => {
    const fd = slotLock(dir, mounted, provider, slots);
    if (fd !== null) closeSync(fd);
    return fd === null;
  });
}

function lock(mounted: string, provider: Provider, slots: number): (() => void) | null {
  const dir = locksDir();
  return exclusive(dir, () => {
    const fd = slotLock(dir, mounted, provider, slots);
    if (fd === null) return null;
    const held = [fd];
    const release = () => {
      for (const each of held) closeSync(each);
    };
    try {
      for (const share of [lockFile(dir, mounted, "at"), lockFile(dir, mounted, provider), ...ancestors(mounted).map((path) => lockFile(dir, path, "under"))]) {
        held.push(take(dir, share, "--shared", "--nonblock"));
      }
    } catch (error) {
      release();
      throw error;
    }
    return release;
  });
}

const startingPrefix = "starting-";
const reserveFraction = 1 / 8;

function meminfo(field: string): number {
  const line = readFileSync("/proc/meminfo", "utf8")
    .split("\n")
    .find((entry) => entry.startsWith(`${field}:`));
  const [value, unit] = (line ?? "")
    .slice(field.length + 1)
    .split(" ")
    .filter((part) => part !== "");
  const kib = Number(value);
  if (unit !== "kB" || !Number.isSafeInteger(kib)) throw new Error(`/proc/meminfo has no ${field} line in kB, and QA Interns starts an environment only when MemAvailable has room for it`);
  return kib * 1024;
}

export function hostMemory(): { total: number; available: number; reserve: number } {
  const total = meminfo("MemTotal");
  return { total, available: meminfo("MemAvailable"), reserve: Math.floor(total * reserveFraction) };
}

export const cpuPressureLimit = 40;

export function cpuPressure(): number {
  const line = readFileSync("/proc/pressure/cpu", "utf8")
    .split("\n")
    .find((entry) => entry.startsWith("some "));
  const field = line?.split(" ").find((part) => part.startsWith("avg60="));
  const value = Number(field?.slice("avg60=".length));
  if (!Number.isFinite(value)) throw new Error(`/proc/pressure/cpu has no "some" avg60 value, and QA Interns starts an environment only while that CPU pressure is at most ${cpuPressureLimit}`);
  return value;
}

export function admit(memory: number, pressureLimit = cpuPressureLimit): (() => void) | null {
  const dir = locksDir();
  return exclusive(dir, () => {
    const { total, reserve } = hostMemory();
    if (memory + reserve > total) {
      const gib = (bytes: number) => (bytes / 1024 ** 3).toFixed(1);
      throw new Error(`An environment of this target can use ${gib(memory)} GiB, which with the reserve of ${gib(reserve)} GiB is more than the ${gib(total)} GiB of memory this host has`);
    }
    if (cpuPressure() > pressureLimit) return null;
    let starting = 0;
    for (const name of readdirSync(dir).filter((entry) => entry.startsWith(startingPrefix))) {
      const file = join(dir, name);
      const fd = flock(file, "--exclusive", "--nonblock");
      if (fd === null) {
        const bytes = Number(name.slice(startingPrefix.length).split("-")[0]);
        if (!Number.isSafeInteger(bytes)) throw new Error(`${file} does not name the memory of a starting environment`);
        starting += bytes;
        continue;
      }
      rmSync(file, { force: true });
      closeSync(fd);
    }
    if (hostMemory().available - reserve - starting < memory) return null;
    const file = join(dir, `${startingPrefix}${memory}-${crypto.randomUUID()}`);
    const fd = take(dir, file, "--exclusive", "--nonblock");
    let started = false;
    return () => {
      if (started) return;
      started = true;
      rmSync(file);
      closeSync(fd);
    };
  });
}

export class Scheduler {
  private readonly slots: Slot[];
  private readonly exhaustedMounts = new Set<string>();
  private readonly live = new Set<Held & { login: Login }>();
  private readonly refused = new Map<string, string[]>();
  private readonly contended = new Set<string>();

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

  leased(): boolean {
    return this.slots.some((slot) => !slot.exhausted && (slot.store === null ? claimed(JSON.stringify(slot.login.seat)) : blocked(slot.store.mounted, slot.login.provider, slot.login.concurrency)));
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
    this.contended.delete(intern);
    while (true) {
      const slot = this.next(tried);
      if (slot === undefined) return null;
      tried.add(slot);
      const unclaim = slot.store === null ? claim(JSON.stringify(slot.login.seat)) : () => {};
      slot.active += 1;
      let lease: Lease | null = null;
      try {
        lease = await this.lease(slot, intern, refused, unclaim);
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

  refusals(intern: string): string[] {
    return this.refused.get(intern) ?? [];
  }

  lost(intern: string): boolean {
    return this.contended.has(intern);
  }

  private async lease(slot: Slot, intern: string, refused: string[], unclaim: () => void): Promise<Lease | null> {
    const { login } = slot;
    if (!(await hasQuota(login))) {
      slot.exhausted = true;
      return null;
    }
    if (slot.store !== null) return this.grant(slot, intern, slot.store, login.concurrency, null, unclaim);
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
        const known = [...this.slots.flatMap((other) => other.store ?? []), ...[...this.live].filter((other) => other.login !== login || other.store !== found.store)];
        const problems = storeProblems(login.provider, path, found, known);
        refuse(problems);
        if (problems.length === 0) {
          const mounted = mountedPath(login.provider, path);
          if (!this.exhaustedMounts.has(mounted)) lease = this.grant(slot, intern, { store: found.store, mounted, where: `login ${login.id}` }, login.concurrency, keeper, unclaim);
        }
      }
    } finally {
      if (lease === null) keeper.kill();
    }
    return lease;
  }

  private grant(slot: Slot, intern: string, grant: Grant, slots: number, keeper: Subprocess | null, unclaim: () => void): Lease | null {
    const unlock = lock(grant.mounted, slot.login.provider, slots);
    if (unlock === null) {
      this.contended.add(intern);
      return null;
    }
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
    const entry = { ...grant, login: slot.login };
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
        writeFileSync(join(locksDir(), releasedFile), `${process.pid}\n`, { mode: 0o600 });
      },
    };
  }

  private next(tried: Set<Slot>): Slot | undefined {
    return this.slots.find((slot) => !slot.exhausted && !tried.has(slot) && slot.active < slot.login.concurrency);
  }
}
