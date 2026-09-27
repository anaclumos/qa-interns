import type { Subprocess } from "bun";
import { realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { z } from "zod";
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
  const storeIndex = new Map<string, number>();
  const credentialIndex = new Map<string, number>();
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
    const sameStore = entry.store !== undefined && storeIndex.has(realpathSync(entry.store));
    if (entry.store !== undefined) {
      const store = realpathSync(entry.store);
      if (store === "/") problems.push(`${where}: store ${entry.store} is the root of the file system`);
      for (const [other, first] of storeIndex) {
        if (other === store) problems.push(`${where}: duplicate store ${entry.store}, already used by logins[${first}]; one store serves one process at a time`);
        else if (store.startsWith(`${other}/`) || other.startsWith(`${store}/`)) {
          problems.push(`${where}: store ${entry.store} contains or is inside the store of logins[${first}]; a runner mounting one could read or change the other`);
        }
      }
      if (!storeIndex.has(store)) storeIndex.set(store, index);
    }
    if (entry.store !== undefined) {
      const name = entry.provider === "claude" ? ".credentials.json" : "auth.json";
      const credential = join(entry.store, name);
      if (statSync(credential, { throwIfNoEntry: false })?.isFile() !== true) problems.push(`${where}: ${entry.provider} store ${entry.store} has no ${name}`);
      else if (!sameStore) {
        const real = realpathSync(credential);
        const first = credentialIndex.get(real);
        if (first === undefined) credentialIndex.set(real, index);
        else problems.push(`${where}: ${credential} is the same file as the credential of logins[${first}]; one credential serves one process at a time`);
      }
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

export type Lease = { login: Login; store: string; release(): void };

type Slot = { login: Login; active: number; exhausted: boolean };

type Seat = { store: string; keeper: Subprocess | null };

async function seat(login: Login, intern: string): Promise<Seat | null> {
  if (login.store !== null) return { store: realpathSync(login.store), keeper: null };
  if (login.seat === null) throw new Error(`Login ${login.id} has neither a store nor a seat command`);
  const keeper = Bun.spawn(["tail", `--pid=${process.pid}`, "-f", "/dev/null"], { stdin: "ignore", stdout: "ignore", stderr: "inherit" });
  try {
    const child = track(Bun.spawn(login.seat, {
      env: { ...process.env, QA_INTERNS_LEASE_PID: String(keeper.pid), QA_INTERNS_INTERN: intern },
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
    if (exitCode === 0 && store !== undefined && isAbsolute(store) && isDirectory(store)) return { store: realpathSync(store), keeper };
  } catch (error) {
    keeper.kill();
    throw error;
  }
  keeper.kill();
  return null;
}

export class Scheduler {
  private readonly slots: Slot[];
  private readonly used: Record<Provider, number> = { claude: 0, codex: 0, cursor: 0, grok: 0 };
  private readonly exhaustedStores = new Set<string>();
  private readonly live = new Set<{ login: Login; store: string }>();

  constructor(logins: Login[]) {
    this.slots = logins.map((login) => ({ login, active: 0, exhausted: false }));
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
      let granted: Seat | null = null;
      try {
        granted = await seat(slot.login, intern);
        if (granted !== null && (this.exhaustedStores.has(granted.store) || this.held(slot.login, granted.store))) {
          granted.keeper?.kill();
          granted = null;
        }
      } finally {
        if (granted === null) slot.active -= 1;
      }
      if (granted === null) continue;
      this.used[slot.login.provider] += 1;
      let released = false;
      const keeper = granted.keeper;
      const entry = { login: slot.login, store: granted.store };
      this.live.add(entry);
      return {
        login: slot.login,
        store: granted.store,
        release: () => {
          if (released) return;
          released = true;
          slot.active -= 1;
          this.live.delete(entry);
          keeper?.kill();
        },
      };
    }
  }

  exhaust(lease: Lease): void {
    const slot = this.slots.find((candidate) => candidate.login.id === lease.login.id);
    if (slot === undefined) throw new Error(`No login with id ${lease.login.id}`);
    if (slot.login.store === null) this.exhaustedStores.add(lease.store);
    else slot.exhausted = true;
  }

  private held(login: Login, store: string): boolean {
    const nested = (a: string, b: string) => a === "/" || b === "/" || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
    return [...this.live].some((lease) => (lease.store === store ? lease.login !== login || login.store === null : nested(lease.store, store)));
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
