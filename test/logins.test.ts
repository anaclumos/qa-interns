import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadLogins, Scheduler, type Lease } from "../src/logins.ts";
import type { Login } from "../src/types.ts";

let dir: string;
let claudeStore: string;
let codexStore: string;
let cursorStore: string;
let emptyStore: string;
let pool: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "qa-interns-logins-"));
  claudeStore = join(dir, "stores", "claude-1");
  codexStore = join(dir, "stores", "codex-1");
  cursorStore = join(dir, "stores", "cursor-1");
  emptyStore = join(dir, "stores", "codex-empty");
  pool = join(dir, "pool");
  for (const store of [claudeStore, join(dir, "stores", "claude-2"), codexStore, cursorStore, emptyStore, pool]) await mkdir(store, { recursive: true });
  await Bun.write(join(claudeStore, ".credentials.json"), "{}");
  await Bun.write(join(codexStore, "auth.json"), "{}");
  await Bun.write(join(cursorStore, "auth.json"), "{}");
  await Bun.write(
    join(dir, "seat.sh"),
    [
      "#!/bin/sh",
      "printf '%s\\n' \"$QA_INTERNS_LEASE_PID\" > \"$(dirname \"$0\")/seat-$QA_INTERNS_INTERN.pid\"",
      "mkdir -p \"$(dirname \"$0\")/pool/$QA_INTERNS_INTERN\"",
      "echo \"leasing a seat for $QA_INTERNS_INTERN\"",
      "echo \"$(dirname \"$0\")/pool/$QA_INTERNS_INTERN\"",
      "echo",
      "",
    ].join("\n"),
  );
  await Bun.write(join(dir, "no-seat.sh"), ["#!/bin/sh", "echo \"$(dirname \"$0\")/stores/codex-1\"", "exit 1", ""].join("\n"));
  await Bun.write(join(dir, "relative-seat.sh"), ["#!/bin/sh", "echo pool/i1", ""].join("\n"));
});

afterAll(async () => {
  await rm(dir, { recursive: true });
});

async function writeLogins(name: string, content: unknown): Promise<string> {
  const file = join(dir, name);
  await Bun.write(file, typeof content === "string" ? content : JSON.stringify(content, null, 2));
  return file;
}

async function failure(name: string, content: unknown): Promise<string> {
  const file = await writeLogins(name, content);
  const error = await loadLogins(file).then(
    () => null,
    (reason: unknown) => reason,
  );
  if (!(error instanceof Error)) throw new Error(`loadLogins accepted ${file}`);
  expect(error.message).toContain(file);
  return error.message;
}

function login(id: string, provider: Login["provider"], concurrency: number, seat: string[] | null = null): Login {
  return { id, provider, store: seat === null ? join(dir, "stores", id) : null, seat, concurrency };
}

function held(lease: Lease | null): Lease {
  if (lease === null) throw new Error("the scheduler granted no lease");
  return lease;
}

async function leasePid(intern: string): Promise<number> {
  return Number((await Bun.file(join(dir, `seat-${intern}.pid`)).text()).trim());
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function ended(pid: number): Promise<boolean> {
  for (let tries = 0; tries < 50 && alive(pid); tries++) await Bun.sleep(20);
  return !alive(pid);
}

describe("loadLogins", () => {
  test("loads mixed providers with stores and a seat pool", async () => {
    const file = await writeLogins("logins.json", {
      logins: [
        { id: "claude-1", provider: "claude", store: claudeStore, concurrency: 2 },
        { id: "codex-1", provider: "codex", store: codexStore, concurrency: 1 },
        { id: "codex-pool", provider: "codex", seat: ["sh", "-c", "exec tokenmaxxing seat --codex \"$QA_INTERNS_LEASE_PID\""], concurrency: 2 },
        { id: "cursor-1", provider: "cursor", store: cursorStore },
      ],
    });
    expect(await loadLogins(file)).toEqual([
      { id: "claude-1", provider: "claude", store: claudeStore, seat: null, concurrency: 2 },
      { id: "codex-1", provider: "codex", store: codexStore, seat: null, concurrency: 1 },
      { id: "codex-pool", provider: "codex", store: null, seat: ["sh", "-c", "exec tokenmaxxing seat --codex \"$QA_INTERNS_LEASE_PID\""], concurrency: 2 },
      { id: "cursor-1", provider: "cursor", store: cursorStore, seat: null, concurrency: 1 },
    ]);
  });

  test("a missing file names the path and the expected shape", async () => {
    const file = join(dir, "absent", "logins.json");
    await expect(loadLogins(file)).rejects.toThrow(`No logins file at ${file}. Create it with this shape: {"logins": [`);
  });

  test("rejects malformed JSON, a missing logins array, and an empty list", async () => {
    expect(await failure("broken.json", "{\"logins\": [")).toContain("is not valid JSON");
    expect(await failure("wrong-top.json", { accounts: [] })).toContain("must hold an object with a \"logins\" array");
    expect(await failure("empty.json", { logins: [] })).toContain("lists no logins");
  });

  test("rejects an unknown provider", async () => {
    expect(await failure("provider.json", { logins: [{ id: "gemini-1", provider: "gemini", store: claudeStore }] })).toContain(
      "logins[0] \"gemini-1\": provider: Invalid option",
    );
  });

  test("rejects both or neither of store and seat", async () => {
    const message = await failure("store-seat.json", {
      logins: [
        { id: "claude-1", provider: "claude", store: claudeStore, seat: ["sh", join(dir, "seat.sh")] },
        { id: "cursor-1", provider: "cursor" },
      ],
    });
    expect(message).toContain("logins[0] \"claude-1\": set exactly one of \"store\" or \"seat\"");
    expect(message).toContain("logins[1] \"cursor-1\": set exactly one of \"store\" or \"seat\"");
  });

  test("rejects a relative store and a store that is not a directory", async () => {
    const message = await failure("stores.json", {
      logins: [
        { id: "claude-1", provider: "claude", store: "stores/claude-1" },
        { id: "claude-2", provider: "claude", store: join(dir, "stores", "missing") },
        { id: "claude-3", provider: "claude", store: join(claudeStore, ".credentials.json") },
      ],
    });
    expect(message).toContain("logins[0] \"claude-1\": store: \"stores/claude-1\" is not an absolute path");
    expect(message).toContain(`logins[1] "claude-2": store: "${join(dir, "stores", "missing")}" is not an existing directory`);
    expect(message).toContain(`logins[2] "claude-3": store: "${join(claudeStore, ".credentials.json")}" is not an existing directory`);
  });

  test("rejects a codex store without auth.json or with concurrency above 1", async () => {
    const message = await failure("codex.json", {
      logins: [
        { id: "codex-empty", provider: "codex", store: emptyStore },
        { id: "codex-1", provider: "codex", store: codexStore, concurrency: 3 },
      ],
    });
    expect(message).toContain(`logins[0] "codex-empty": codex store ${emptyStore} has no auth.json`);
    expect(message).toContain("logins[1] \"codex-1\": a codex store must have concurrency 1");
  });

  test("rejects a claude store without .credentials.json", async () => {
    const message = await failure("claude.json", { logins: [{ id: "claude-empty", provider: "claude", store: emptyStore }] });
    expect(message).toContain(`logins[0] "claude-empty": claude store ${emptyStore} has no .credentials.json`);
  });

  test("rejects two logins that name the same store after resolving the path", async () => {
    const message = await failure("same-store.json", {
      logins: [
        { id: "claude-1", provider: "claude", store: claudeStore },
        { id: "claude-2", provider: "claude", store: `${claudeStore}/../claude-1/` },
      ],
    });
    expect(message).toContain(`logins[1] "claude-2": duplicate store ${claudeStore}/../claude-1/, already used by logins[0]`);
  });

  test("rejects two logins that name the same store through a symbolic link", async () => {
    const link = join(dir, "claude-link");
    await symlink(claudeStore, link);
    const message = await failure("linked-store.json", {
      logins: [
        { id: "claude-1", provider: "claude", store: claudeStore },
        { id: "claude-2", provider: "claude", store: link },
      ],
    });
    expect(message).toContain(`logins[1] "claude-2": duplicate store ${link}, already used by logins[0]`);
  });

  test("rejects a store inside another login's store", async () => {
    const inner = join(cursorStore, "codex-inner");
    await mkdir(inner, { recursive: true });
    await Bun.write(join(inner, "auth.json"), "{}");
    const message = await failure("nested-store.json", {
      logins: [
        { id: "cursor-1", provider: "cursor", store: cursorStore },
        { id: "codex-inner", provider: "codex", store: inner },
      ],
    });
    expect(message).toContain(`logins[1] "codex-inner": store ${inner} contains or is inside the store of logins[0]`);
  });

  test("rejects two stores whose credential files are the same file", async () => {
    const second = join(dir, "stores", "codex-linked");
    await mkdir(second, { recursive: true });
    await symlink(join(codexStore, "auth.json"), join(second, "auth.json"));
    const message = await failure("shared-credential.json", {
      logins: [
        { id: "codex-1", provider: "codex", store: codexStore },
        { id: "codex-2", provider: "codex", store: second },
      ],
    });
    expect(message).toContain(`logins[1] "codex-2": ${join(second, "auth.json")} is the same file as the credential of logins[0]`);
  });

  test("rejects duplicate ids and reports every problem at once", async () => {
    const message = await failure("many.json", {
      logins: [
        { id: "claude-1", provider: "claude", store: claudeStore },
        { id: "claude-1", provider: "claude", store: claudeStore },
        { provider: "cursor", store: cursorStore, concurency: 2 },
        { id: "codex-pool", provider: "codex", seat: [], concurrency: 0 },
      ],
    });
    expect(message.split("\n").slice(1)).toEqual([
      "  logins[1] \"claude-1\": duplicate id, already used by logins[0]",
      `  logins[1] "claude-1": duplicate store ${claudeStore}, already used by logins[0]; one store serves one process at a time`,
      "  logins[2]: id: Invalid input: expected string, received undefined",
      "  logins[2]: Unrecognized key: \"concurency\"",
      "  logins[3] \"codex-pool\": seat: Too small: expected array to have >=1 items",
      "  logins[3] \"codex-pool\": concurrency: Too small: expected number to be >0",
    ]);
  });
});

describe("Scheduler", () => {
  test("prefers providers not avoided, then the least used provider, then the most spare capacity, then file order", async () => {
    const scheduler = new Scheduler([login("claude-1", "claude", 1), login("claude-2", "claude", 2), login("codex-1", "codex", 1), login("cursor-1", "cursor", 1)]);
    const first = await scheduler.acquire("i1", []);
    const second = await scheduler.acquire("i2", []);
    const third = await scheduler.acquire("i3", []);
    const fourth = await scheduler.acquire("i4", ["claude"]);
    const fifth = await scheduler.acquire("i5", ["claude"]);
    expect([first, second, third, fourth, fifth].map((lease) => lease?.login.id)).toEqual(["claude-2", "codex-1", "cursor-1", "claude-1", "claude-2"]);
    expect(first?.store).toBe(join(dir, "stores", "claude-2"));
    expect(await scheduler.acquire("i6", [])).toBeNull();
  });

  test("avoids providers when another has spare capacity and counts use across the run", async () => {
    const scheduler = new Scheduler([login("claude-1", "claude", 2), login("codex-1", "codex", 3), login("cursor-1", "cursor", 1)]);
    expect((await scheduler.acquire("c1", ["claude", "codex"]))?.login.id).toBe("cursor-1");
    const codex = await scheduler.acquire("c2", ["claude"]);
    expect(codex?.login.id).toBe("codex-1");
    codex?.release();
    expect((await scheduler.acquire("c3", []))?.login.id).toBe("claude-1");
  });

  test("capacity counts concurrency of logins not exhausted, and release is idempotent", async () => {
    const scheduler = new Scheduler([login("claude-1", "claude", 1), login("codex-1", "codex", 1), login("cursor-1", "cursor", 3)]);
    expect(scheduler.capacity()).toBe(5);
    expect(scheduler.providers()).toEqual(["claude", "codex", "cursor"]);

    const claude = await scheduler.acquire("i1", ["codex", "cursor"]);
    expect(claude?.login.id).toBe("claude-1");
    expect(scheduler.capacity()).toBe(5);
    claude?.release();
    claude?.release();
    const again = await scheduler.acquire("i2", ["codex", "cursor"]);
    expect(again?.login.id).toBe("claude-1");
    expect((await scheduler.acquire("i3", ["codex", "cursor"]))?.login.id).toBe("cursor-1");

    scheduler.exhaust(held(again));
    expect(scheduler.capacity()).toBe(4);
    expect(scheduler.providers()).toEqual(["codex", "cursor"]);
    again?.release();
    const picks = await Promise.all(["i4", "i5", "i6", "i7"].map((intern) => scheduler.acquire(intern, [])));
    expect(picks.map((lease) => lease?.login.id ?? null).sort()).toEqual(["codex-1", "cursor-1", "cursor-1", null]);

    scheduler.exhaust(held(picks.find((lease) => lease?.login.id === "cursor-1") ?? null));
    scheduler.exhaust(held(picks.find((lease) => lease?.login.id === "codex-1") ?? null));
    expect(scheduler.capacity()).toBe(0);
    expect(scheduler.providers()).toEqual([]);
    expect(await scheduler.acquire("i8", [])).toBeNull();
    const unknown = { login: login("claude-9", "claude", 1), store: join(dir, "stores", "claude-9"), release: () => {} };
    expect(() => scheduler.exhaust(unknown)).toThrow("No login with id claude-9");
  });

  test("a seat command gives each intern its own store and a lease pid that lives until release", async () => {
    const scheduler = new Scheduler([login("codex-pool", "codex", 2, ["sh", join(dir, "seat.sh")])]);
    const [one, two, three] = await Promise.all(["i1", "i2", "i3"].map((intern) => scheduler.acquire(intern, [])));
    expect(one?.store).toBe(join(pool, "i1"));
    expect(two?.store).toBe(join(pool, "i2"));
    expect(three).toBeNull();
    const [first, second] = [await leasePid("i1"), await leasePid("i2")];
    expect(first).not.toBe(second);
    expect(first).not.toBe(process.pid);
    expect(alive(first)).toBe(true);
    one?.release();
    expect(await ended(first)).toBe(true);
    expect(alive(second)).toBe(true);
    expect((await scheduler.acquire("i4", []))?.store).toBe(join(pool, "i4"));
    two?.release();
  });

  test("a usage limit on a seat login exhausts only that store, and a later grant of it is released at once", async () => {
    const scheduler = new Scheduler([login("codex-pool", "codex", 2, ["sh", join(dir, "seat.sh")]), login("cursor-1", "cursor", 1)]);
    const limited = held(await scheduler.acquire("j1", ["cursor"]));
    expect(limited.store).toBe(join(pool, "j1"));
    scheduler.exhaust(limited);
    limited.release();
    expect(scheduler.capacity()).toBe(3);
    expect(scheduler.providers()).toEqual(["codex", "cursor"]);

    const retry = await scheduler.acquire("j1", ["cursor"]);
    expect(retry?.login.id).toBe("cursor-1");
    expect(await ended(await leasePid("j1"))).toBe(true);

    const others = await Promise.all(["j2", "j3"].map((intern) => scheduler.acquire(intern, ["cursor"])));
    expect(others.map((lease) => lease?.store)).toEqual([join(pool, "j2"), join(pool, "j3")]);
    for (const lease of [retry, ...others]) lease?.release();
  });

  test("a seat store reached through a symbolic link is the same store as its target once exhausted", async () => {
    const shared = join(dir, "shared-seat");
    await mkdir(join(dir, "links"), { recursive: true });
    await mkdir(shared);
    await symlink(shared, join(dir, "links", "k1"));
    await symlink(shared, join(dir, "links", "k2"));
    await Bun.write(join(dir, "linked-seat.sh"), ["#!/bin/sh", "echo \"$(dirname \"$0\")/links/$QA_INTERNS_INTERN\"", ""].join("\n"));
    const scheduler = new Scheduler([login("codex-pool", "codex", 2, ["sh", join(dir, "linked-seat.sh")])]);
    const first = held(await scheduler.acquire("k1", []));
    expect(first.store).toBe(await realpath(shared));
    scheduler.exhaust(first);
    first.release();
    expect(await scheduler.acquire("k2", [])).toBeNull();
  });

  test("a store that a live lease holds is released at once when a seat login returns it, until that lease ends", async () => {
    await mkdir(join(dir, "same-store"));
    await Bun.write(
      join(dir, "same-seat.sh"),
      ["#!/bin/sh", "printf '%s\\n' \"$QA_INTERNS_LEASE_PID\" > \"$(dirname \"$0\")/seat-$QA_INTERNS_INTERN.pid\"", "echo \"$(dirname \"$0\")/same-store\"", ""].join("\n"),
    );
    const command = ["sh", join(dir, "same-seat.sh")];
    const scheduler = new Scheduler([login("codex-pool-a", "codex", 2, command), login("codex-pool-b", "codex", 1, command)]);
    const first = held(await scheduler.acquire("m1", []));
    expect(first.login.id).toBe("codex-pool-a");
    expect(first.store).toBe(await realpath(join(dir, "same-store")));
    expect(await scheduler.acquire("m2", [])).toBeNull();
    expect(await ended(await leasePid("m2"))).toBe(true);
    expect(alive(await leasePid("m1"))).toBe(true);
    first.release();
    const second = held(await scheduler.acquire("m3", []));
    expect(second.store).toBe(first.store);
    second.release();
  });

  test("a failing seat command or a relative path moves on to the next login", async () => {
    const scheduler = new Scheduler([
      login("codex-pool", "codex", 4, ["sh", join(dir, "no-seat.sh")]),
      login("claude-pool", "claude", 3, ["sh", join(dir, "relative-seat.sh")]),
      login("cursor-1", "cursor", 1),
    ]);
    const lease = await scheduler.acquire("i1", []);
    expect(lease?.login.id).toBe("cursor-1");
    expect(lease?.store).toBe(cursorStore);
    expect(await scheduler.acquire("i2", [])).toBeNull();
    expect(scheduler.capacity()).toBe(8);
  });

  test("a seat command that cannot start throws and keeps no reservation", async () => {
    const scheduler = new Scheduler([login("codex-pool", "codex", 1, [join(dir, "missing-seat-command")])]);
    await expect(scheduler.acquire("i1", [])).rejects.toThrow("ENOENT");
    await expect(scheduler.acquire("i2", [])).rejects.toThrow("ENOENT");
  });
});
