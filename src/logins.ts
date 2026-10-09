import { dlopen, read } from "bun:ffi";
import { createHash } from "node:crypto";
import { closeSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, watch, writeFileSync, type Stats } from "node:fs";
import { constants, homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { z } from "zod";
import { credentialName, credentialRule, readKey } from "./pi.ts";
import { readJson, stateDir } from "./state.ts";
import { errorCode } from "./findings.ts";
import type { Login } from "./types.ts";

export const defaultLoginsPath = join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "qa-interns", "logins.json");

const example = `{"id": "openrouter-1", "store": "/absolute/path/to/login-store", "concurrency": 4}`;

const loginSchema = z.strictObject({
  id: z.string().min(1),
  store: z
    .string()
    .refine(isAbsolute, { error: (issue) => `${JSON.stringify(issue.input)} is not an absolute path`, abort: true })
    .refine(isDirectory, { error: (issue) => `${JSON.stringify(issue.input)} is not an existing directory` }),
  concurrency: z.int().positive().default(1),
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
  return { id: parsed.data.id, store: parsed.data.store, concurrency: parsed.data.concurrency };
}

export type Lease = { login: Login; credential: string; release(): void };

const libc = dlopen("libc.so.6", {
  flock: { args: ["i32", "i32"], returns: "i32" },
  __errno_location: { args: [], returns: "ptr" },
});
const lockModes = { shared: 1, exclusive: 2 };
const lockNonblock = 4;

export function flock(file: string, mode: "shared" | "exclusive", wait: "block" | "nonblock"): number | null {
  const fd = openSync(file, "a", 0o600);
  const operation = lockModes[mode] | (wait === "nonblock" ? lockNonblock : 0);
  for (;;) {
    if (libc.symbols.flock(fd, operation) === 0) return fd;
    const errno = read.i32(libc.symbols.__errno_location()!);
    if (errno === constants.errno.EINTR) continue;
    closeSync(fd);
    if (errno === constants.errno.EWOULDBLOCK) return null;
    throw new Error(`flock on ${file} failed with errno ${errno}`);
  }
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

function take(dir: string, file: string, mode: "shared" | "exclusive", wait: "block" | "nonblock"): number {
  const fd = flock(file, mode, wait);
  if (fd === null) throw new Error(`${file} is locked by a process that does not hold ${join(dir, "acquire.lock")}`);
  return fd;
}

function exclusive<T>(dir: string, body: () => T): T {
  const mutex = take(dir, join(dir, "acquire.lock"), "exclusive", "block");
  try {
    return body();
  } finally {
    closeSync(mutex);
  }
}

function slotLock(dir: string, mounted: string, slots: number): number | null {
  for (let slot = 0; slot < slots; slot++) {
    const fd = flock(lockFile(dir, mounted, String(slot)), "exclusive", "nonblock");
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

function cgroupBytes(file: string, value: string): number {
  const bytes = Number(value);
  if (value === "" || !Number.isSafeInteger(bytes) || bytes < 0) throw new Error(`${file} holds ${JSON.stringify(value)}, not a byte count, and QA Interns starts an environment only when its cgroup has room for it`);
  return bytes;
}

export function hostMemory(cgroupFile = "/proc/self/cgroup", cgroupRoot = "/sys/fs/cgroup"): { total: number; available: number; reserve: number; limit: string } {
  let total = meminfo("MemTotal");
  let available = meminfo("MemAvailable");
  let limit = "host";
  const line = readFileSync(cgroupFile, "utf8")
    .split("\n")
    .find((entry) => entry.startsWith("0::/"));
  if (line === undefined) throw new Error(`${cgroupFile} has no cgroup v2 line, and QA Interns reads the memory limit of its cgroup v2 hierarchy`);
  const parts = line.slice("0::/".length).split("/").filter((part) => part !== "");
  if (parts.some((part) => part === "." || part === "..")) throw new Error(`${cgroupFile} names the cgroup ${line.slice("0::".length)}, which is outside ${cgroupRoot}`);
  for (let depth = parts.length; depth >= 0; depth--) {
    const dir = join(cgroupRoot, ...parts.slice(0, depth));
    const maxFile = join(dir, "memory.max");
    let max: string;
    try {
      max = readFileSync(maxFile, "utf8").trim();
    } catch (error) {
      if (errorCode(error) === "ENOENT") continue;
      throw error;
    }
    if (max === "max") continue;
    const cap = cgroupBytes(maxFile, max);
    const currentFile = join(dir, "memory.current");
    const statFile = join(dir, "memory.stat");
    const inactive = readFileSync(statFile, "utf8")
      .split("\n")
      .find((entry) => entry.startsWith("inactive_file "));
    if (inactive === undefined) throw new Error(`${statFile} has no inactive_file line, and QA Interns counts the memory of its cgroup without the reclaimable file cache`);
    if (cap < total) {
      total = cap;
      limit = dir;
    }
    available = Math.min(available, cap - cgroupBytes(currentFile, readFileSync(currentFile, "utf8").trim()) + cgroupBytes(statFile, inactive.slice("inactive_file ".length).trim()));
  }
  return { total, available, reserve: Math.floor(total * reserveFraction), limit };
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

export function admit(environmentMemory: number, pressureLimit = cpuPressureLimit): (() => void) | null {
  const dir = locksDir();
  return exclusive(dir, () => {
    const { total, reserve } = hostMemory();
    const memory = environmentMemory + reserve > total ? Math.floor(total / 2) : environmentMemory;
    if (cpuPressure() > pressureLimit) return null;
    let starting = 0;
    for (const name of readdirSync(dir).filter((entry) => entry.startsWith(startingPrefix))) {
      const file = join(dir, name);
      const fd = flock(file, "exclusive", "nonblock");
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
    const fd = take(dir, file, "exclusive", "nonblock");
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
