import type { Subprocess } from "bun";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { admit, hostMemory, loadLogin, Scheduler, watchReleases, type Lease } from "../src/logins.ts";
import type { Login } from "../src/types.ts";

const holders = new Set<Subprocess>();
const key = "sk-or-v1-test-key";
let dir: string;
let store: string;
let emptyStore: string;
const previousStateHome = process.env.XDG_STATE_HOME;

function auth(value: string): string {
  return JSON.stringify({ openrouter: { type: "api_key", key: value } });
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "qa-interns-logins-"));
  process.env.XDG_STATE_HOME = join(dir, "state");
  store = join(dir, "stores", "openrouter-1");
  emptyStore = join(dir, "stores", "empty");
  for (const each of [store, emptyStore]) await mkdir(each, { recursive: true });
  await Bun.write(join(store, "auth.json"), auth(key));
  await Bun.write(
    join(dir, "holder.ts"),
    [
      `import { Scheduler } from ${JSON.stringify(join(import.meta.dir, "..", "src", "logins.ts"))};`,
      "const scheduler = new Scheduler(JSON.parse(process.argv[2]));",
      "const leases = [];",
      "for (let index = 0; index < Number(process.argv[3]); index++) leases.push(scheduler.acquire());",
      "console.log(leases.filter((lease) => lease !== null).length);",
      "for await (const _ of Bun.stdin.stream()) {}",
      "for (const lease of leases) lease?.release();",
      "",
    ].join("\n"),
  );
});

afterAll(async () => {
  if (previousStateHome === undefined) delete process.env.XDG_STATE_HOME;
  else process.env.XDG_STATE_HOME = previousStateHome;
  await rm(dir, { recursive: true });
});

async function writeLogin(name: string, content: unknown): Promise<string> {
  const file = join(dir, name);
  await Bun.write(file, typeof content === "string" ? content : JSON.stringify(content, null, 2));
  return file;
}

async function failure(name: string, content: unknown): Promise<string> {
  const file = await writeLogin(name, content);
  const error = await loadLogin(file).then(
    () => null,
    (reason: unknown) => reason,
  );
  if (!(error instanceof Error)) throw new Error(`loadLogin accepted ${file}`);
  expect(error.message).toContain(file);
  return error.message;
}

function login(concurrency: number, path = store): Login {
  return { id: "openrouter-1", store: path, concurrency, model: null };
}

function held(lease: Lease | null): Lease {
  if (lease === null) throw new Error("the scheduler granted no lease");
  return lease;
}

async function holder(entry: Login, count: number) {
  const child = Bun.spawn([process.execPath, join(dir, "holder.ts"), JSON.stringify(entry), String(count)], {
    env: { ...process.env },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "inherit",
  });
  holders.add(child);
  const { value } = await child.stdout.getReader().read();
  return { count: Number(new TextDecoder().decode(value).trim()), child };
}

afterEach(async () => {
  for (const child of holders) {
    child.kill("SIGKILL");
    await child.exited;
  }
  holders.clear();
});

describe("loadLogin", () => {
  test("loads the login with its store, concurrency, and model, and defaults to one lease and the agent's model", async () => {
    const file = await writeLogin("login.json", { id: "openrouter-1", store, concurrency: 3, model: "openrouter/xiaomi/mimo-v2.6-pro" });
    expect(await loadLogin(file)).toEqual({ id: "openrouter-1", store, concurrency: 3, model: "openrouter/xiaomi/mimo-v2.6-pro" });
    const plain = await writeLogin("plain.json", { id: "openrouter-1", store });
    expect(await loadLogin(plain)).toEqual({ id: "openrouter-1", store, concurrency: 1, model: null });
  });

  test("a missing file names the path and the expected shape", async () => {
    const file = join(dir, "absent", "logins.json");
    await expect(loadLogin(file)).rejects.toThrow(`No logins file at ${file}. Create it with this shape: {"id": "openrouter-1", "store": `);
  });

  test("rejects malformed JSON and a list of logins", async () => {
    expect(await failure("broken.json", "{\"id\": ")).toContain("is not valid JSON");
    const list = await failure("list.json", { logins: [{ id: "openrouter-1", store }] });
    expect(list.split("\n").slice(1)).toEqual([
      "  id: Invalid input: expected string, received undefined",
      "  store: Invalid input: expected string, received undefined",
      "  Unrecognized key: \"logins\"",
    ]);
  });

  test("rejects a relative store and a store that is not a directory", async () => {
    const loop = join(dir, "store-loop");
    const locked = join(dir, "store-locked");
    await symlink(loop, loop);
    await mkdir(join(locked, "store"), { recursive: true });
    await chmod(locked, 0o000);
    const unreachable = [join(store, "auth.json", "store"), join(dir, "a".repeat(256)), loop, join(locked, "store"), join(dir, "stores", "missing"), join(store, "auth.json")];
    try {
      expect(await failure("relative.json", { id: "openrouter-1", store: "stores/openrouter-1" })).toContain("store: \"stores/openrouter-1\" is not an absolute path");
      for (const [index, path] of unreachable.entries()) {
        expect(await failure(`unreachable-${index}.json`, { id: "openrouter-1", store: path })).toContain(`store: "${path}" is not an existing directory`);
      }
    } finally {
      await chmod(locked, 0o700);
    }
  });

  test("rejects a store without auth.json, and one whose auth.json is a symbolic link loop or cannot be reached", async () => {
    const looped = join(dir, "looped");
    const closed = join(dir, "closed");
    await mkdir(looped, { recursive: true });
    await symlink(join(looped, "auth.json"), join(looped, "auth.json"));
    await mkdir(closed, { recursive: true });
    await Bun.write(join(closed, "auth.json"), auth(key));
    await chmod(closed, 0o600);
    try {
      for (const path of [emptyStore, looped, closed]) {
        expect(await failure("no-credential.json", { id: "openrouter-1", store: path })).toContain(`store ${path} has no auth.json`);
      }
    } finally {
      await chmod(closed, 0o700);
    }
  });

  test("accepts an auth.json that holds one OpenRouter API key of at least 8 characters, also through a symbolic link, and rejects any other content without quoting it", async () => {
    const linked = join(dir, "stores", "linked");
    await mkdir(linked, { recursive: true });
    await symlink(join(store, "auth.json"), join(linked, "auth.json"));
    expect((await loadLogin(await writeLogin("linked.json", { id: "openrouter-1", store: linked }))).store).toBe(linked);

    const contents: Record<string, string> = {
      empty: "{}",
      blank: auth(""),
      short: auth("sk-or-7"),
      extra: JSON.stringify({ openrouter: { type: "api_key", key: "router-key" }, anthropic: { type: "api_key", key: "other-key" } }),
      other: JSON.stringify({ anthropic: { type: "api_key", key: "other-key" } }),
      oauth: JSON.stringify({ openrouter: { type: "oauth", refresh: "refresh-token", access: "access-token", expires: 0 } }),
      field: JSON.stringify({ openrouter: { type: "api_key", key: "router-key", metadata: { label: "metadata-value" } } }),
      broken: "{",
    };
    for (const [name, content] of Object.entries(contents)) {
      const path = join(dir, "stores", `bad-${name}`);
      await mkdir(path, { recursive: true });
      await Bun.write(join(path, "auth.json"), content);
      const message = await failure(`bad-${name}.json`, { id: "openrouter-1", store: path });
      expect(message).toContain(`${join(path, "auth.json")} must hold one OpenRouter API key of at least 8 characters and nothing else`);
      for (const value of ["sk-or-7", "router-key", "other-key", "refresh-token", "access-token", "metadata-value"]) expect(message).not.toContain(value);
    }
  });

  test("reports every problem of the login object at once", async () => {
    const message = await failure("many.json", { store, concurency: 2, concurrency: 0, model: "" });
    expect(message.split("\n").slice(1)).toEqual([
      "  id: Invalid input: expected string, received undefined",
      "  concurrency: Too small: expected number to be >0",
      "  model: Too small: expected string to have >=1 characters",
      "  Unrecognized key: \"concurency\"",
    ]);
  });
});

describe("Scheduler", () => {
  test("leases up to the login's concurrency, and a release frees one lease once", () => {
    const scheduler = new Scheduler(login(2));
    expect(scheduler.capacity()).toBe(2);
    const first = held(scheduler.acquire());
    const second = held(scheduler.acquire());
    expect(scheduler.acquire()).toBeNull();
    expect(first.credential).toBe(join(store, "auth.json"));
    first.release();
    first.release();
    const third = held(scheduler.acquire());
    expect(scheduler.acquire()).toBeNull();
    second.release();
    third.release();
  });

  test("locks the real path of auth.json, so stores that link to one key share its concurrency", async () => {
    const linked = join(dir, "stores", "shared");
    await mkdir(linked, { recursive: true });
    await symlink(join(store, "auth.json"), join(linked, "auth.json"));
    const lease = held(new Scheduler(login(1)).acquire());
    const other = new Scheduler(login(1, linked));
    expect(other.acquire()).toBeNull();
    lease.release();
    const next = held(other.acquire());
    expect(next.credential).toBe(join(store, "auth.json"));
    next.release();
  });

  test("another process's leases count against the concurrency until that process ends, up to the highest concurrency either sets", async () => {
    const other = await holder(login(1), 1);
    expect(other.count).toBe(1);
    const scheduler = new Scheduler(login(1));
    expect(scheduler.acquire()).toBeNull();
    other.child.kill("SIGKILL");
    await other.child.exited;
    held(scheduler.acquire()).release();

    const sharing = await holder(login(2), 2);
    expect(sharing.count).toBe(2);
    const wider = new Scheduler(login(3));
    const one = held(wider.acquire());
    expect(wider.acquire()).toBeNull();
    sharing.child.stdin.end();
    await sharing.child.exited;
    const two = held(wider.acquire());
    one.release();
    two.release();
  });

  test("a lease that another process releases wakes a release watcher in this process", async () => {
    const other = await holder(login(1), 1);
    expect(other.count).toBe(1);
    const scheduler = new Scheduler(login(1));
    expect(scheduler.acquire()).toBeNull();
    const woken = Promise.withResolvers<void>();
    const unwatch = watchReleases(() => woken.resolve());
    try {
      other.child.stdin.end();
      await woken.promise;
      held(scheduler.acquire()).release();
    } finally {
      unwatch();
    }
  });

  test("a lease that this or another process holds counts as leased until it ends", async () => {
    const scheduler = new Scheduler(login(1));
    expect(scheduler.leased()).toBe(false);
    const own = held(scheduler.acquire());
    expect(scheduler.leased()).toBe(true);
    own.release();
    expect(scheduler.leased()).toBe(false);

    const other = await holder(login(1), 1);
    expect(other.count).toBe(1);
    expect(scheduler.acquire()).toBeNull();
    expect(scheduler.leased()).toBe(true);
    other.child.kill("SIGKILL");
    await other.child.exited;
    expect(scheduler.leased()).toBe(false);
  });

  test("an acquire that finds every slot of the login locked by another process counts as lost until the next acquire", async () => {
    const full = new Scheduler(login(1));
    const own = held(full.acquire());
    expect(full.acquire()).toBeNull();
    expect(full.lost()).toBe(false);
    own.release();
    const other = await holder(login(1), 1);
    expect(other.count).toBe(1);
    const scheduler = new Scheduler(login(1));
    expect(scheduler.acquire()).toBeNull();
    expect(scheduler.lost()).toBe(true);
    other.child.kill("SIGKILL");
    await other.child.exited;
    held(scheduler.acquire()).release();
    expect(scheduler.lost()).toBe(false);
  });

  test("a store whose auth.json breaks the store rule stops the scheduler", async () => {
    expect(() => new Scheduler(login(1, emptyStore))).toThrow(`login openrouter-1: store ${emptyStore} has no auth.json`);
  });
});

describe("admit", () => {
  test("admits an environment only while available memory less the reserve and every environment still starting holds it, in this process and across processes", async () => {
    const { available, reserve } = hostMemory();
    const size = Math.floor((available - reserve) * 0.6);
    const first = admit(size, 100);
    if (first === null) throw new Error("admit refused the first environment");
    expect(admit(size, 100)).toBeNull();
    first();
    first();

    await Bun.write(
      join(dir, "admitter.ts"),
      [
        `import { admit } from ${JSON.stringify(join(import.meta.dir, "..", "src", "logins.ts"))};`,
        "const started = admit(Number(process.argv[2]), 100);",
        'console.log(started === null ? "refused" : "admitted");',
        "for await (const _ of Bun.stdin.stream()) {}",
        "started?.();",
        "",
      ].join("\n"),
    );
    const child = Bun.spawn([process.execPath, join(dir, "admitter.ts"), String(size)], { env: { ...process.env }, stdin: "pipe", stdout: "pipe", stderr: "inherit" });
    holders.add(child);
    const { value } = await child.stdout.getReader().read();
    expect(new TextDecoder().decode(value).trim()).toBe("admitted");
    expect(admit(size, 100)).toBeNull();
    child.kill("SIGKILL");
    await child.exited;
    const after = admit(size, 100);
    expect(after).not.toBeNull();
    after?.();
  });

  test("holds every environment while CPU pressure is above the limit, and counts no held one as starting", () => {
    const { available, reserve } = hostMemory();
    const size = Math.floor((available - reserve) * 0.6);
    expect(admit(size, -1)).toBeNull();
    const started = admit(size, 100);
    expect(started).not.toBeNull();
    started?.();
  });

  test("counts an environment that cannot fit the host's memory as half of it, so two never start together and none throws", () => {
    const size = hostMemory().total * 2;
    const first = admit(size, 100);
    const second = admit(size, 100);
    second?.();
    first?.();
    expect(first !== null && second !== null).toBe(false);
  });
});
