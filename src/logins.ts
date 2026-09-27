import type { Subprocess } from "bun";
import { createHash } from "node:crypto";
import { closeSync, mkdirSync, openSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { z } from "zod";
import { stateDir } from "./state.ts";
import { track } from "./target.ts";
import type { Login, Provider } from "./types.ts";

export const defaultLoginsPath = join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "qa-interns", "logins.json");

const example = `{"logins": [{"id": "claude-1", "provider": "claude", "store": "/absolute/path/to/login-store"}]}`;

const entrySchema = z.strictObject({
  id: z.string().min(1),
  provider: z.enum(["claude", "codex", "cursor", "grok"]),
  store: z
    .string()
    .refine(isAbsolute, { error: (issue) => `${JSON.stringify(issue.input)} is not an absolute path`, abort: true })
    .refine(isDirectory, { error: (issue) => `${JSON.stringify(issue.input)} is not an existing directory` })
    .optional(),
  seat: z.array(z.string().min(1)).min(1).optional(),
  concurrency: z.int().positive().default(1),
});

function isDirectory(path: string): boolean {
  return statSync(path, { throwIfNoEntry: false })?.isDirectory() === true;
}

function rawId(value: unknown): string | null {
  return typeof value === "object" && value !== null && "id" in value && typeof value.id === "string" ? value.id : null;
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
  return problems;
}

export async function loadLogins(file: string): Promise<Login[]> {
  const handle = Bun.file(file);
  if (!(await handle.exists())) throw new Error(`No logins file at ${file}. Create it with this shape: ${example}`);
  let raw: unknown;
  try {
    raw = JSON.parse(await handle.text());
  } catch (error) {
    throw new Error(`${file} is not valid JSON: ${String(error)}`);
  }
  const top = z.object({ logins: z.array(z.unknown()) }).safeParse(raw);
  if (!top.success) throw new Error(`${file} must hold an object with a "logins" array, for example ${example}`);
  if (top.data.logins.length === 0) throw new Error(`${file} lists no logins. Add at least one, for example ${example}`);

  const problems: string[] = [];
  const logins: Login[] = [];
  const firstIndex = new Map<string, number>();
  const known: Held[] = [];
  for (const [index, value] of top.data.logins.entries()) {
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
        problems.push(issue.path.length === 0 ? `${where}: ${issue.message}` : `${where}: ${issue.path.join(".")}: ${issue.message}`);
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
    logins.push({ id: entry.id, provider: entry.provider, store: entry.store ?? null, seat: entry.seat ?? null, concurrency: entry.concurrency });
  }
  if (problems.length > 0) throw new Error(`${file} has problems:\n${problems.map((problem) => `  ${problem}`).join("\n")}`);
  return logins;
}

export type Lease = { login: Login; store: string; credential: string; release(): void };

type Slot = { login: Login; active: number; exhausted: boolean; store: { store: string; credential: string; where: string } | null };

const lockHeld = 75;

async function seatStore(command: string[], leasePid: number, intern: string): Promise<string | null> {
  const child = track(Bun.spawn(command, {
    env: { ...process.env, QA_INTERNS_LEASE_PID: String(leasePid), QA_INTERNS_INTERN: intern },
    stdout: "pipe",
    stderr: "inherit",
    timeout: 60_000,
  }));
  const [stdout, exitCode] = await Promise.all([child.stdout.text(), child.exited]);
  const store = stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .at(-1);
  return exitCode === 0 && store !== undefined && isAbsolute(store) && isDirectory(store) ? store : null;
}

function lock(credential: string, slots: number): (() => void) | null {
  const dir = join(stateDir(), "locks");
  mkdirSync(dir, { recursive: true });
  const key = createHash("sha256").update(credential).digest("hex");
  for (let slot = 0; slot < slots; slot++) {
    const file = join(dir, `${key}-${slot}.lock`);
    const fd = openSync(file, "a", 0o600);
    let code: number;
    try {
      code = Bun.spawnSync(["flock", "--nonblock", "--conflict-exit-code", String(lockHeld), "3"], { stdio: ["ignore", "ignore", "inherit", fd] }).exitCode;
    } catch (error) {
      closeSync(fd);
      throw error;
    }
    if (code === 0) return () => closeSync(fd);
    closeSync(fd);
    if (code !== lockHeld) throw new Error(`flock on ${file} exited with ${code}`);
  }
  return null;
}

export class Scheduler {
  private readonly slots: Slot[];
  private readonly used: Record<Provider, number> = { claude: 0, codex: 0, cursor: 0, grok: 0 };
  private readonly exhaustedCredentials = new Set<string>();
  private readonly live = new Set<Held>();

  constructor(logins: Login[]) {
    this.slots = logins.map((login) => {
      if (login.store === null) return { login, active: 0, exhausted: false, store: null };
      const found = resolveStore(login.provider, login.store);
      if (found.credential === null) throw new Error(`${login.provider} store ${login.store} has no ${credentialName(login.provider)}`);
      return { login, active: 0, exhausted: false, store: { store: found.store, credential: found.credential, where: `login ${login.id}` } };
    });
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
      slot.active += 1;
      let lease: Lease | null = null;
      try {
        lease = await this.lease(slot, intern);
      } finally {
        if (lease === null) slot.active -= 1;
      }
      if (lease !== null) return lease;
    }
  }

  exhaust(lease: Lease): void {
    const slot = this.slots.find((candidate) => candidate.login.id === lease.login.id);
    if (slot === undefined) throw new Error(`No login with id ${lease.login.id}`);
    if (slot.login.store === null) this.exhaustedCredentials.add(lease.credential);
    else slot.exhausted = true;
  }

  private async lease(slot: Slot, intern: string): Promise<Lease | null> {
    const { login } = slot;
    if (slot.store !== null) return this.grant(slot, slot.store.store, slot.store.credential, login.concurrency, null);
    if (login.seat === null) throw new Error(`Login ${login.id} has neither a store nor a seat command`);
    const keeper = Bun.spawn(["tail", `--pid=${process.pid}`, "-f", "/dev/null"], { stdin: "ignore", stdout: "ignore", stderr: "inherit" });
    let lease: Lease | null = null;
    try {
      const path = await seatStore(login.seat, keeper.pid, intern);
      if (path !== null) {
        const found = resolveStore(login.provider, path);
        const known = [...this.slots.flatMap((other) => other.store ?? []), ...this.live];
        if (found.credential !== null && !this.exhaustedCredentials.has(found.credential) && storeProblems(login.provider, path, found, known).length === 0) {
          lease = this.grant(slot, found.store, found.credential, 1, keeper);
        }
      }
    } finally {
      if (lease === null) keeper.kill();
    }
    return lease;
  }

  private grant(slot: Slot, store: string, credential: string, slots: number, keeper: Subprocess | null): Lease | null {
    const unlock = lock(credential, slots);
    if (unlock === null) return null;
    this.used[slot.login.provider] += 1;
    const entry = { store, credential, where: `login ${slot.login.id}` };
    this.live.add(entry);
    let released = false;
    return {
      login: slot.login,
      store,
      credential,
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
