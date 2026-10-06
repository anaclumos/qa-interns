import { createHash } from "node:crypto";
import { closeSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, watch, writeFileSync, type Stats } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { z } from "zod";
import { credentialName, credentialRule, readKey } from "./pi.ts";
import { readJson, stateDir } from "./state.ts";
import { errorCode } from "./findings.ts";
import type { Login } from "./types.ts";

export const defaultLoginsPath = join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "qa-interns", "logins.json");

const example = `{"id": "openrouter-1", "store": "/absolute/path/to/login-store", "concurrency": 4, "model": "openrouter/xiaomi/mimo-v2.6-pro"}`;

const loginSchema = z.strictObject({
  id: z.string().min(1),
  store: z
    .string()
    .refine(isAbsolute, { error: (issue) => `${JSON.stringify(issue.input)} is not an absolute path`, abort: true })
    .refine(isDirectory, { error: (issue) => `${JSON.stringify(issue.input)} is not an existing directory` }),
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

function credentialProblem(store: string): string | null {
  const file = join(store, credentialName);
  if (stat(file)?.isFile() !== true) return `store ${store} has no ${credentialName}`;
  if (readKey(file) === null) return `${file} ${credentialRule}; the agent can read every credential in it`;
  return null;
}

function invalid(file: string, problems: string[]): Error {
  return new Error(`${file} has problems:\n${problems.map((problem) => `  ${problem}`).join("\n")}`);
}

export async function loadLogin(file: string): Promise<Login> {
  const value = await readJson(file, z.unknown(), `No logins file at ${file}. Create it with this shape: ${example}`);
  const parsed = loginSchema.safeParse(value);
  if (!parsed.success) throw invalid(file, parsed.error.issues.map((issue) => (issue.path.length === 0 ? issue.message : `${z.core.toDotPath(issue.path)}: ${issue.message}`)));
  const problem = credentialProblem(parsed.data.store);
  if (problem !== null) throw invalid(file, [problem]);
  return { id: parsed.data.id, store: parsed.data.store, concurrency: parsed.data.concurrency, model: parsed.data.model ?? null };
}

export type Lease = { login: Login; credential: string; release(): void };

const lockHeld = 75;

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

function slotLock(dir: string, mounted: string, slots: number): number | null {
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
  const fd = exclusive(dir, () => slotLock(dir, mounted, slots));
  return fd === null ? null : () => closeSync(fd);
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
  private active = 0;
  private contended = false;
  private readonly credential: string;

  constructor(private readonly login: Login) {
    const problem = credentialProblem(login.store);
    if (problem !== null) throw new Error(`login ${login.id}: ${problem}`);
    this.credential = realpathSync(join(login.store, credentialName));
  }

  leased(): boolean {
    return blocked(this.credential, this.login.concurrency);
  }

  capacity(): number {
    return this.login.concurrency;
  }

  lost(): boolean {
    return this.contended;
  }

  acquire(): Lease | null {
    this.contended = false;
    if (this.active >= this.login.concurrency) return null;
    const unlock = lock(this.credential, this.login.concurrency);
    if (unlock === null) {
      this.contended = true;
      return null;
    }
    this.active += 1;
    let released = false;
    return {
      login: this.login,
      credential: this.credential,
      release: () => {
        if (released) return;
        released = true;
        this.active -= 1;
        unlock();
        writeFileSync(join(locksDir(), releasedFile), `${process.pid}\n`, { mode: 0o600 });
      },
    };
  }
}
