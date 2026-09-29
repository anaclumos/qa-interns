import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { keepHostSecrets, keepSeedSecrets, redact, redactFiles, redactJson } from "../src/secrets.ts";
import { failure } from "../src/target.ts";

const asRoot = process.getuid?.() === 0;
const roots: string[] = [];

afterAll(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true });
});

async function scratch(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "qa-interns-secrets-"));
  roots.push(root);
  return root;
}

describe("keepSeedSecrets", () => {
  test("keep every non-empty string under a listed field, at any depth, and no other value", () => {
    const seed = {
      accounts: [
        { email: "owner@north.test", password: "north-owner-pass", apiKey: { live: "sk_live_north_4f9a1c", test: "" } },
        { email: "viewer@north.test", password: "north-viewer-pass", apiKey: null },
      ],
      data: { summary: "North has 12 invoices.", invoiceCount: 12 },
    };
    keepSeedSecrets(seed, ["password", "apiKey"]);
    expect(redact("owner@north.test north-owner-pass north-viewer-pass sk_live_north_4f9a1c North has 12 invoices.")).toBe(
      "owner@north.test [redacted] [redacted] [redacted] North has 12 invoices.",
    );
  });

  test("keep the values it found, then fail when a listed field is in no object of the seed output", () => {
    expect(() => keepSeedSecrets({ accounts: [{ password: "south-owner-pass" }] }, ["password", "token"])).toThrow(
      'customizations["qa-interns"].secrets.seed names token, which the seed output has no field for',
    );
    expect(redact("south-owner-pass")).toBe("[redacted]");
  });

  test("keep the long values, then fail on a short one without quoting it", () => {
    const seed = { accounts: [{ pin: "4821" }, { pin: "east-owner-pin" }] };
    expect(() => keepSeedSecrets(seed, ["pin"])).toThrow("A value under the seed field pin has fewer than 8 characters");
    expect(() => keepSeedSecrets(seed, ["pin"])).not.toThrow("4821");
    expect(redact("east-owner-pin 4821")).toBe("[redacted] 4821");
  });
});

describe("keepHostSecrets", () => {
  test("keep the values of the listed variables and skip an empty one", () => {
    process.env.QA_INTERNS_TEST_TOKEN = "tok_9c2e7b4f1a";
    process.env.QA_INTERNS_TEST_EMPTY = "";
    try {
      keepHostSecrets(["QA_INTERNS_TEST_TOKEN", "QA_INTERNS_TEST_EMPTY"]);
      expect(redact("Bearer tok_9c2e7b4f1a.")).toBe("Bearer [redacted].");
    } finally {
      delete process.env.QA_INTERNS_TEST_TOKEN;
      delete process.env.QA_INTERNS_TEST_EMPTY;
    }
  });

  test("fail on a value too short to remove", () => {
    process.env.QA_INTERNS_TEST_TOKEN = "1";
    try {
      expect(() => keepHostSecrets(["QA_INTERNS_TEST_TOKEN"])).toThrow("The value of QA_INTERNS_TEST_TOKEN has fewer than 8 characters");
    } finally {
      delete process.env.QA_INTERNS_TEST_TOKEN;
    }
  });
});

describe("redact", () => {
  test("replace a value as written and in each JSON string escaping of it", () => {
    keepSeedSecrets({ password: 'pa"ss\\word' }, ["password"]);
    const once = JSON.stringify({ password: 'pa"ss\\word' });
    const twice = JSON.stringify({ prompt: `Seed:\n${once}` });
    expect(redact('Sign in with pa"ss\\word.')).toBe("Sign in with [redacted].");
    expect(redact(once)).toBe('{"password":"[redacted]"}');
    expect(redact(twice)).toBe('{"prompt":"Seed:\\n{\\"password\\":\\"[redacted]\\"}"}');
  });

  test("replace a longer value before a value it contains", () => {
    keepSeedSecrets({ keys: ["sk_west_4f9a", "sk_west_4f9a1c2e7b"] }, ["keys"]);
    expect(redact("keys sk_west_4f9a1c2e7b and sk_west_4f9a")).toBe("keys [redacted] and [redacted]");
  });
});

describe("failure", () => {
  test("replace a value before cutting the error output, so no part of it is left at the cut", () => {
    keepSeedSecrets({ key: "sk_cut_4f9a1c2e7b5d" }, ["key"]);
    const error = failure(["docker", "compose", "up"], 1, `sk_cut_4f9a1c2e7b5d${"y".repeat(1995)}`);
    expect(error.message).toStartWith("docker compose up exited with 1: ");
    expect(error.message).not.toContain("e7b5d");
    expect(error.message).toEndWith("y".repeat(1995));
  });
});

describe("redactJson", () => {
  test("replace values inside strings only, so keys and numbers stay and the JSON stays valid", () => {
    keepSeedSecrets({ pin: "87654321" }, ["pin"]);
    const value = { count: 87654321, steps: ["Send the pin 87654321."], nested: { "87654321": "pin 87654321" } };
    expect(redactJson(value)).toEqual({ count: 87654321, steps: ["Send the pin [redacted]."], nested: { "87654321": "pin [redacted]" } });
  });
});

describe("redactFiles", () => {
  beforeAll(() => keepSeedSecrets({ key: "sk_files_4f9a1c2e7b" }, ["key"]));

  test("replace the bytes of each value in every file under the directories, text or not", async () => {
    const root = await scratch();
    const out = path.join(root, "interns", "i1", "out");
    await mkdir(path.join(out, "findings"), { recursive: true });
    await mkdir(path.join(out, "evidence"), { recursive: true });
    await writeFile(path.join(out, "findings", "key.json"), `${JSON.stringify({ observed: "The page shows sk_files_4f9a1c2e7b." })}\n`);
    await writeFile(path.join(out, "evidence", "dump.bin"), Buffer.concat([Buffer.from([0xff, 0x00]), Buffer.from("sk_files_4f9a1c2e7b"), Buffer.from([0xfe])]));
    await writeFile(path.join(root, "interns", "i1", "adapter.log"), "no secret here\n");
    await redactFiles([path.join(root, "interns"), path.join(root, "envs")]);
    expect(await readFile(path.join(out, "findings", "key.json"), "utf8")).toBe('{"observed":"The page shows [redacted]."}\n');
    expect(await readFile(path.join(out, "evidence", "dump.bin"))).toEqual(Buffer.concat([Buffer.from([0xff, 0x00]), Buffer.from("[redacted]"), Buffer.from([0xfe])]));
    expect(await readFile(path.join(root, "interns", "i1", "adapter.log"), "utf8")).toBe("no secret here\n");
  });

  test("leave a file a symbolic link points to untouched, whether the link names the file or its directory", async () => {
    const root = await scratch();
    const outside = path.join(root, "home");
    await mkdir(outside);
    await writeFile(path.join(outside, ".profile"), "export TOKEN=sk_files_4f9a1c2e7b\n");
    const evidence = path.join(root, "interns", "i1", "out", "evidence");
    await mkdir(evidence, { recursive: true });
    await symlink(path.join(outside, ".profile"), path.join(evidence, "profile.txt"));
    await symlink(outside, path.join(evidence, "home"));
    await redactFiles([path.join(root, "interns")]);
    expect(await readFile(path.join(outside, ".profile"), "utf8")).toBe("export TOKEN=sk_files_4f9a1c2e7b\n");
  });

  test.skipIf(asRoot)("fail on a file that holds a value and cannot be written, and leave a read-only file without one alone", async () => {
    const root = await scratch();
    const dir = path.join(root, "interns", "i1", "out");
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "clean.txt"), "nothing to remove\n");
    await chmod(path.join(dir, "clean.txt"), 0o444);
    await redactFiles([path.join(root, "interns")]);
    await writeFile(path.join(dir, "held.txt"), "sk_files_4f9a1c2e7b\n");
    await chmod(path.join(dir, "held.txt"), 0o444);
    await expect(redactFiles([path.join(root, "interns")])).rejects.toThrow("EACCES");
  });
});
