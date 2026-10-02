import type { Subprocess } from "bun";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rename, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadLogins, Scheduler, type Lease } from "../src/logins.ts";
import type { Login } from "../src/types.ts";

const holders = new Set<Subprocess>();
let dir: string;
let claudeStore: string;
let codexStore: string;
let cursorStore: string;
let grokStore: string;
let emptyStore: string;
let pool: string;
const previousStateHome = process.env.XDG_STATE_HOME;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "qa-interns-logins-"));
  process.env.XDG_STATE_HOME = join(dir, "state");
  claudeStore = join(dir, "stores", "claude-1");
  codexStore = join(dir, "stores", "codex-1");
  cursorStore = join(dir, "stores", "cursor-1");
  grokStore = join(dir, "stores", "grok-1");
  emptyStore = join(dir, "stores", "codex-empty");
  pool = join(dir, "pool");
  for (const store of [claudeStore, join(dir, "stores", "claude-2"), codexStore, cursorStore, grokStore, emptyStore, pool]) await mkdir(store, { recursive: true });
  await Bun.write(join(claudeStore, ".credentials.json"), "{}");
  await Bun.write(join(dir, "stores", "claude-2", ".credentials.json"), "{}");
  await Bun.write(join(codexStore, "auth.json"), "{}");
  await Bun.write(join(cursorStore, "auth.json"), "{}");
  await Bun.write(join(grokStore, "auth.json"), "{}");
  await Bun.write(
    join(dir, "seat.sh"),
    [
      "#!/bin/sh",
      "printf '%s\\n' \"$QA_INTERNS_LEASE_PID\" > \"$(dirname \"$0\")/seat-$QA_INTERNS_INTERN.pid\"",
      "mkdir -p \"$(dirname \"$0\")/pool/$QA_INTERNS_INTERN\"",
      "echo '{}' > \"$(dirname \"$0\")/pool/$QA_INTERNS_INTERN/auth.json\"",
      "echo \"leasing a seat for $QA_INTERNS_INTERN\"",
      "echo \"$(dirname \"$0\")/pool/$QA_INTERNS_INTERN\"",
      "echo",
      "",
    ].join("\n"),
  );
  await Bun.write(join(dir, "no-seat.sh"), ["#!/bin/sh", "echo \"$(dirname \"$0\")/stores/codex-1\"", "exit 1", ""].join("\n"));
  await Bun.write(join(dir, "relative-seat.sh"), ["#!/bin/sh", "echo pool/i1", ""].join("\n"));
  await Bun.write(
    join(dir, "holder.ts"),
    [
      `import { Scheduler } from ${JSON.stringify(join(import.meta.dir, "..", "src", "logins.ts"))};`,
      "const scheduler = new Scheduler(JSON.parse(process.argv[2]));",
      "const leases = [];",
      "for (let index = 0; index < Number(process.argv[3]); index++) leases.push(await scheduler.acquire(`h${index}`, []));",
      "console.log(leases.filter((lease) => lease !== null).length);",
      "for await (const _ of Bun.stdin.stream()) {}",
      "",
    ].join("\n"),
  );
});

afterAll(async () => {
  if (previousStateHome === undefined) delete process.env.XDG_STATE_HOME;
  else process.env.XDG_STATE_HOME = previousStateHome;
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
  return { id, provider, store: seat === null ? join(dir, "stores", id) : null, seat, concurrency, model: null };
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

function releaseAll(leases: (Lease | null | undefined)[]): void {
  for (const lease of leases) lease?.release();
}

async function holder(logins: Login[], count: number) {
  const child = Bun.spawn([process.execPath, join(dir, "holder.ts"), JSON.stringify(logins), String(count)], {
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

describe("loadLogins", () => {
  test("loads mixed providers with stores and a seat pool", async () => {
    const file = await writeLogins("logins.json", {
      logins: [
        { id: "claude-1", provider: "claude", store: claudeStore, concurrency: 2 },
        { id: "codex-1", provider: "codex", store: codexStore, concurrency: 1 },
        { id: "codex-pool", provider: "codex", seat: ["sh", "-c", "exec tokenmaxxing seat --codex \"$QA_INTERNS_LEASE_PID\""], concurrency: 2 },
        { id: "cursor-1", provider: "cursor", store: cursorStore, model: "grok-4.7[context=256k,reasoning_effort=high,fast=true]" },
        { id: "grok-1", provider: "grok", store: grokStore },
      ],
    });
    expect(await loadLogins(file)).toEqual([
      { id: "claude-1", provider: "claude", store: claudeStore, seat: null, concurrency: 2, model: null },
      { id: "codex-1", provider: "codex", store: codexStore, seat: null, concurrency: 1, model: null },
      {
        id: "codex-pool",
        provider: "codex",
        store: null,
        seat: ["sh", "-c", "exec tokenmaxxing seat --codex \"$QA_INTERNS_LEASE_PID\""],
        concurrency: 2,
        model: null,
      },
      {
        id: "cursor-1",
        provider: "cursor",
        store: cursorStore,
        seat: null,
        concurrency: 1,
        model: "grok-4.7[context=256k,reasoning_effort=high,fast=true]",
      },
      { id: "grok-1", provider: "grok", store: grokStore, seat: null, concurrency: 1, model: null },
    ]);
  });

  test("a missing file names the path and the expected shape", async () => {
    const file = join(dir, "absent", "logins.json");
    await expect(loadLogins(file)).rejects.toThrow(`No logins file at ${file}. Create it with this shape: {"logins": [`);
  });

  test("rejects malformed JSON, a missing logins array, and an empty list", async () => {
    expect(await failure("broken.json", "{\"logins\": [")).toContain("is not valid JSON");
    expect(await failure("wrong-top.json", { accounts: [] })).toContain("is invalid:\n✖ Invalid input: expected array, received undefined\n  → at logins");
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

  test("rejects a claude store that is or contains the Claude Code config directory", async () => {
    const previous = process.env.CLAUDE_CONFIG_DIR;
    const link = join(dir, "claude-config-link");
    await symlink(claudeStore, link);
    await mkdir(join(dir, "stores", "claude-2", "config"), { recursive: true });
    try {
      process.env.CLAUDE_CONFIG_DIR = link;
      const is = await failure("claude-config.json", { logins: [{ id: "claude-1", provider: "claude", store: claudeStore }] });
      expect(is).toContain(`logins[0] "claude-1": claude store ${claudeStore} is or contains the Claude Code config directory ${claudeStore}`);
      process.env.CLAUDE_CONFIG_DIR = join(dir, "stores", "claude-2", "config");
      const contains = await failure("claude-config-parent.json", { logins: [{ id: "claude-2", provider: "claude", store: join(dir, "stores", "claude-2") }] });
      expect(contains).toContain(`logins[0] "claude-2": claude store ${join(dir, "stores", "claude-2")} is or contains the Claude Code config directory ${join(dir, "stores", "claude-2", "config")}`);
    } finally {
      if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = previous;
    }
  });

  test("rejects a store whose path resolves through a symbolic link or whose credential file is a symbolic link", async () => {
    const linked = join(dir, "stores", "claude-linked");
    const inside = join(dir, "stores", "grok-linked");
    const codex = join(dir, "stores", "codex-linked");
    const grok = join(dir, "stores", "grok-link");
    const other = join(dir, "host", "other-grok-home");
    await mkdir(linked, { recursive: true });
    await mkdir(inside, { recursive: true });
    await mkdir(codex, { recursive: true });
    await mkdir(other, { recursive: true });
    await symlink(join(claudeStore, ".credentials.json"), join(linked, ".credentials.json"));
    await Bun.write(join(inside, "real.json"), "{}");
    await symlink(join(inside, "real.json"), join(inside, "auth.json"));
    await Bun.write(join(dir, "host", "unrelated-file"), "{}");
    await symlink(join(dir, "host", "unrelated-file"), join(codex, "auth.json"));
    await Bun.write(join(other, "auth.json"), "{}");
    await symlink(other, grok);
    const message = await failure("linked-credential.json", {
      logins: [
        { id: "claude-linked", provider: "claude", store: linked },
        { id: "grok-linked", provider: "grok", store: inside },
        { id: "codex-linked", provider: "codex", store: codex },
        { id: "grok-link", provider: "grok", store: grok },
      ],
    });
    expect(message).toContain(`logins[0] "claude-linked": ${join(linked, ".credentials.json")} is a symbolic link`);
    expect(message).toContain(`logins[1] "grok-linked": ${join(inside, "auth.json")} is a symbolic link`);
    expect(message).toContain(`logins[2] "codex-linked": ${join(codex, "auth.json")} is a symbolic link`);
    expect(message).toContain(`logins[3] "grok-link": store ${grok} resolves through a symbolic link to ${other}`);
  });

  test("rejects a grok store without auth.json", async () => {
    const message = await failure("grok.json", { logins: [{ id: "grok-empty", provider: "grok", store: emptyStore }] });
    expect(message).toContain(`logins[0] "grok-empty": grok store ${emptyStore} has no auth.json`);
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
    releaseAll([first, second, third, fourth, fifth]);
  });

  test("avoids providers when another has spare capacity and counts use across the run", async () => {
    const scheduler = new Scheduler([login("claude-1", "claude", 2), login("codex-1", "codex", 3), login("cursor-1", "cursor", 1)]);
    const cursor = await scheduler.acquire("c1", ["claude", "codex"]);
    expect(cursor?.login.id).toBe("cursor-1");
    const codex = await scheduler.acquire("c2", ["claude"]);
    expect(codex?.login.id).toBe("codex-1");
    codex?.release();
    const claude = await scheduler.acquire("c3", []);
    expect(claude?.login.id).toBe("claude-1");
    releaseAll([cursor, claude]);
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
    const cursor = await scheduler.acquire("i3", ["codex", "cursor"]);
    expect(cursor?.login.id).toBe("cursor-1");

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
    const unknown = { login: login("claude-9", "claude", 1), store: join(dir, "stores", "claude-9"), mounted: join(dir, "stores", "claude-9"), release: () => {} };
    expect(() => scheduler.exhaust(unknown)).toThrow("No login with id claude-9");
    releaseAll([cursor, ...picks]);
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
    const four = await scheduler.acquire("i4", []);
    expect(four?.store).toBe(join(pool, "i4"));
    releaseAll([two, four]);
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

  test("a store that a live lease holds is released at once when a seat login returns it, until that lease ends", async () => {
    await mkdir(join(dir, "same-store"));
    await Bun.write(join(dir, "same-store", "auth.json"), "{}");
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
    expect(scheduler.refusals("i2")).toEqual(["seat store of login claude-pool: the last line its command printed is not an absolute path"]);
    expect(scheduler.capacity()).toBe(8);
    lease?.release();
  });

  test("a seat store that breaks a store rule counts as no store", async () => {
    const bare = join(dir, "seat-cases", "bare");
    const linked = join(dir, "seat-cases", "linked");
    const real = join(dir, "seat-cases", "real");
    await mkdir(bare, { recursive: true });
    await mkdir(linked, { recursive: true });
    await mkdir(real, { recursive: true });
    await Bun.write(join(dir, "seat-cases", "unrelated-file"), "{}");
    await symlink(join(dir, "seat-cases", "unrelated-file"), join(linked, "auth.json"));
    await Bun.write(join(real, "auth.json"), "{}");
    await symlink(real, join(dir, "seat-cases", "through"));
    await Bun.write(join(dir, "stores", "auth.json"), "{}");
    const through = join(dir, "seat-cases", "through");
    const cases: [Login["provider"], string, string][] = [
      ["cursor", "/", "store / is the root of the file system"],
      ["codex", bare, `codex store ${bare} has no auth.json`],
      ["codex", codexStore, `duplicate store ${codexStore}, already used by login codex-1; one store serves one process at a time`],
      ["cursor", join(dir, "stores"), `store ${join(dir, "stores")} contains or is inside the store of login codex-1; a runner mounting one could read or change the other`],
      ["codex", linked, `${join(linked, "auth.json")} is a symbolic link; a runner can place a link in its own store to choose what another run mounts, so the credential is a regular file in the store`],
      ["cursor", through, `store ${through} resolves through a symbolic link to ${real}; a runner can place a link in its own store to choose what another run mounts`],
      ["codex", join(dir, "missing"), `store ${join(dir, "missing")} is not an existing directory`],
    ];
    for (const [provider, store, problem] of cases) {
      const scheduler = new Scheduler([login("seat-pool", provider, 1, ["echo", store]), login("codex-1", "codex", 1)]);
      const lease = held(await scheduler.acquire("s1", []));
      expect([store, lease.login.id]).toEqual([store, "codex-1"]);
      expect(await scheduler.acquire("s2", [])).toBeNull();
      expect([store, scheduler.refusals("s2")]).toEqual([store, expect.arrayContaining([`seat store of login seat-pool: ${problem}`])]);
      lease.release();
    }
  });

  test("a configured store that moves away during a run does not stop seat leases", async () => {
    const moving = join(dir, "moving", "claude-m");
    await mkdir(moving, { recursive: true });
    await Bun.write(join(moving, ".credentials.json"), "{}");
    const scheduler = new Scheduler([{ id: "claude-m", provider: "claude", store: moving, seat: null, concurrency: 1, model: null }, login("codex-pool", "codex", 1, ["sh", join(dir, "seat.sh")])]);
    await rename(join(dir, "moving"), join(dir, "moved"));
    const lease = held(await scheduler.acquire("v1", ["claude"]));
    expect(lease.store).toBe(join(pool, "v1"));
    lease.release();
  });

  test("a configured store that breaks a store rule stops the scheduler", async () => {
    const store = join(dir, "grok-linked");
    await mkdir(join(store, "tokens"), { recursive: true });
    await Bun.write(join(store, "tokens", "auth.json"), "{}");
    await symlink("tokens/auth.json", join(store, "auth.json"));
    const grok: Login = { id: "grok-linked", provider: "grok", store, seat: null, concurrency: 1, model: null };
    expect(() => new Scheduler([grok])).toThrow(`login grok-linked: ${join(store, "auth.json")} is a symbolic link`);
    expect(() => new Scheduler([login("codex-1", "codex", 1), { ...login("codex-1", "codex", 1), id: "codex-2" }])).toThrow(
      `login codex-2: duplicate store ${codexStore}, already used by login codex-1`,
    );
  });

  test("a store replaced with a symbolic link after the scheduler checks it is not leased", async () => {
    const child = join(dir, "swapped", "child");
    const elsewhere = join(dir, "swapped", "elsewhere");
    for (const store of [child, elsewhere]) {
      await mkdir(store, { recursive: true });
      await Bun.write(join(store, ".credentials.json"), "{}");
      await Bun.write(join(store, "auth.json"), "{}");
    }
    const claude: Login = { id: "claude-swapped", provider: "claude", store: child, seat: null, concurrency: 1, model: null };
    const codex: Login = { id: "codex-swapped", provider: "codex", store: child, seat: null, concurrency: 1, model: null };
    const wholeStore = new Scheduler([claude]);
    const fileStore = new Scheduler([codex]);
    await rename(child, join(dir, "swapped", "kept"));
    await symlink(elsewhere, child);
    await expect(wholeStore.acquire("x1", [])).rejects.toThrow(`login claude-swapped: store ${child} changed after its check; ${child} resolves to ${elsewhere}, not ${child}`);
    await expect(fileStore.acquire("x2", [])).rejects.toThrow(
      `login codex-swapped: store ${child} changed after its check; ${join(child, "auth.json")} resolves to ${join(elsewhere, "auth.json")}, not ${join(child, "auth.json")}`,
    );
    await rm(child);
    await rename(join(dir, "swapped", "kept"), child);
    await rename(join(child, "auth.json"), join(child, "auth.json.kept"));
    await symlink(join(elsewhere, "auth.json"), join(child, "auth.json"));
    await expect(fileStore.acquire("x3", [])).rejects.toThrow(`${join(child, "auth.json")} resolves to ${join(elsewhere, "auth.json")}, not ${join(child, "auth.json")}`);
    await rm(join(child, "auth.json"));
    await rename(join(child, "auth.json.kept"), join(child, "auth.json"));
    const whole = held(await wholeStore.acquire("x4", []));
    expect(whole.mounted).toBe(child);
    whole.release();
    const file = held(await fileStore.acquire("x5", []));
    expect(file.mounted).toBe(join(child, "auth.json"));
    file.release();
  });

  test("a store mounted whole stays locked when its agent replaces the credential file", async () => {
    const store = join(dir, "grok-replaced");
    await mkdir(store);
    await Bun.write(join(store, "auth.json"), "{}");
    const grok: Login = { id: "grok-replaced", provider: "grok", store, seat: null, concurrency: 1, model: null };
    const first = held(await new Scheduler([grok]).acquire("r1", []));
    await Bun.write(join(store, "auth.json.new"), "{}");
    await rename(join(store, "auth.json.new"), join(store, "auth.json"));
    const other = new Scheduler([grok]);
    expect(await other.acquire("r2", [])).toBeNull();
    first.release();
    const second = held(await other.acquire("r3", []));
    expect(second.store).toBe(store);
    second.release();
  });

  test("another process's lease on a credential counts against its concurrency until that process ends", async () => {
    const codex = login("codex-1", "codex", 1);
    const other = await holder([codex], 1);
    expect(other.count).toBe(1);
    const scheduler = new Scheduler([codex]);
    expect(await scheduler.acquire("p1", [])).toBeNull();
    other.child.kill("SIGKILL");
    await other.child.exited;
    const lease = held(await scheduler.acquire("p2", []));
    expect(lease.store).toBe(codexStore);
    lease.release();

    const claude = login("claude-1", "claude", 2);
    const sharing = await holder([claude], 1);
    expect(sharing.count).toBe(1);
    const shared = new Scheduler([claude]);
    const one = held(await shared.acquire("q1", []));
    expect(await shared.acquire("q2", [])).toBeNull();
    sharing.child.stdin.end();
    await sharing.child.exited;
    const two = held(await shared.acquire("q3", []));
    releaseAll([one, two]);
  });

  test("a lease that this or another process holds or is acquiring counts as leased until it ends, unless its login is exhausted here", async () => {
    const codex = login("codex-1", "codex", 1);
    const scheduler = new Scheduler([codex]);
    expect(scheduler.leased()).toBe(false);
    const own = held(await scheduler.acquire("v1", []));
    expect(scheduler.leased()).toBe(true);
    own.release();
    expect(scheduler.leased()).toBe(false);

    const other = await holder([codex], 1);
    expect(other.count).toBe(1);
    expect(await scheduler.acquire("v2", [])).toBeNull();
    expect(scheduler.leased()).toBe(true);
    const exhausted = new Scheduler([codex]);
    exhausted.exhaust({ login: codex, store: codexStore, mounted: codexStore, release: () => {} });
    expect(exhausted.leased()).toBe(false);
    other.child.kill("SIGKILL");
    await other.child.exited;
    expect(scheduler.leased()).toBe(false);

    await Bun.write(join(dir, "slow-seat.sh"), ["#!/bin/sh", "sleep 0.5", "exec sh \"$(dirname \"$0\")/seat.sh\"", ""].join("\n"));
    const seat = login("codex-pool", "codex", 2, ["sh", join(dir, "slow-seat.sh")]);
    const seats = new Scheduler([seat]);
    const pending = seats.acquire("v3", []);
    expect(new Scheduler([seat]).leased()).toBe(true);
    held(await pending).release();
    expect(seats.leased()).toBe(false);
    const elsewhere = await holder([seat], 1);
    expect(elsewhere.count).toBe(1);
    expect(seats.leased()).toBe(true);
    const lent = new Scheduler([{ id: "codex-h0", provider: "codex", store: join(pool, "h0"), seat: null, concurrency: 1, model: null }]);
    expect(lent.leased()).toBe(true);
    elsewhere.child.kill("SIGKILL");
    await elsewhere.child.exited;
    expect(seats.leased()).toBe(false);
    expect(lent.leased()).toBe(false);
  });

  test("another process's lease blocks a lease whose mounted path contains or sits inside its own until that process ends", async () => {
    const outer = join(dir, "nested", "outer");
    const inner = join(outer, "inner");
    const twin = join(dir, "nested", "outer-twin");
    for (const store of [inner, twin]) await mkdir(store, { recursive: true });
    for (const store of [outer, inner, twin]) await Bun.write(join(store, "auth.json"), "{}");
    await Bun.write(join(inner, ".credentials.json"), "{}");
    const cursor: Login = { id: "cursor-outer", provider: "cursor", store: outer, seat: null, concurrency: 1, model: null };
    const beside: Login = { id: "cursor-twin", provider: "cursor", store: twin, seat: null, concurrency: 1, model: null };
    const codex: Login = { id: "codex-inner", provider: "codex", store: inner, seat: null, concurrency: 1, model: null };
    const claude: Login = { id: "claude-inner", provider: "claude", store: inner, seat: null, concurrency: 1, model: null };
    const grok: Login = { id: "grok-inner", provider: "grok", store: inner, seat: null, concurrency: 1, model: null };

    const outside = await holder([cursor], 1);
    expect(outside.count).toBe(1);
    expect(await new Scheduler([codex]).acquire("u1", [])).toBeNull();
    expect(new Scheduler([codex]).leased()).toBe(true);
    expect(await new Scheduler([claude]).acquire("u2", [])).toBeNull();
    expect(await new Scheduler([grok]).acquire("u3", [])).toBeNull();
    const next = held(await new Scheduler([beside]).acquire("u4", []));
    outside.child.stdin.end();
    await outside.child.exited;

    const inside = await holder([codex], 1);
    expect(inside.count).toBe(1);
    const scheduler = new Scheduler([cursor]);
    expect(await scheduler.acquire("u5", [])).toBeNull();
    inside.child.kill("SIGKILL");
    await inside.child.exited;
    const lease = held(await scheduler.acquire("u6", []));
    expect(lease.store).toBe(outer);
    releaseAll([next, lease]);
  });

  test("a seat command that cannot start throws and keeps no reservation", async () => {
    const scheduler = new Scheduler([login("codex-pool", "codex", 1, [join(dir, "missing-seat-command")])]);
    await expect(scheduler.acquire("i1", [])).rejects.toThrow("ENOENT");
    await expect(scheduler.acquire("i2", [])).rejects.toThrow("ENOENT");
  });
});
