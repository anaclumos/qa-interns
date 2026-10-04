import { createHash } from "node:crypto";
import { closeSync, mkdirSync, openSync, realpathSync, statSync, type Stats } from "node:fs";
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

export class Scheduler {
  private active = 0;
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

  acquire(): Lease | null {
    if (this.active >= this.login.concurrency) return null;
    const unlock = lock(this.credential, this.login.concurrency);
    if (unlock === null) return null;
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
      },
    };
  }
}
