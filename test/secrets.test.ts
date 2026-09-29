import { afterAll, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { hostSecrets, redactFiles, redactJson, redactor, seedSecrets } from "../src/secrets.ts";

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

const seed = {
  accounts: [
    { email: "owner@acme.test", password: "acme-owner-pass", apiKey: { live: "sk_live_4f9a1c2e7b", test: "" } },
    { email: "viewer@acme.test", password: "acme-viewer-pass", apiKey: null },
  ],
  data: { summary: "Acme has 23 invoices.", acmeInvoiceCount: 23 },
};

describe("seedSecrets", () => {
  test("return every non-empty string under a listed field, at any depth", () => {
    expect(seedSecrets(seed, ["password", "apiKey"]).sort()).toEqual(["acme-owner-pass", "acme-viewer-pass", "sk_live_4f9a1c2e7b"]);
  });

  test("return nothing when the target lists no field", () => {
    expect(seedSecrets(seed, [])).toEqual([]);
  });

  test("fail when a listed field is in no object of the seed output", () => {
    expect(() => seedSecrets(seed, ["password", "token"])).toThrow('customizations["qa-interns"].secrets.seed names token, which the seed output has no field for');
  });

  test("fail on a value under a listed field that is too short to remove, without quoting the value", () => {
    const short = { accounts: [{ email: "owner@acme.test", pin: "4821" }] };
    expect(() => seedSecrets(short, ["pin"])).toThrow("A value under the seed field pin has fewer than 8 characters");
    expect(() => seedSecrets(short, ["pin"])).not.toThrow("4821");
  });
});

describe("hostSecrets", () => {
  test("return the values of the listed variables and skip an empty one", () => {
    process.env.QA_INTERNS_TEST_TOKEN = "tok_9c2e7b4f1a";
    process.env.QA_INTERNS_TEST_EMPTY = "";
    try {
      expect(hostSecrets(["QA_INTERNS_TEST_TOKEN", "QA_INTERNS_TEST_EMPTY"])).toEqual(["tok_9c2e7b4f1a"]);
    } finally {
      delete process.env.QA_INTERNS_TEST_TOKEN;
      delete process.env.QA_INTERNS_TEST_EMPTY;
    }
  });

  test("fail on a value too short to remove", () => {
    process.env.QA_INTERNS_TEST_TOKEN = "1";
    try {
      expect(() => hostSecrets(["QA_INTERNS_TEST_TOKEN"])).toThrow("The value of QA_INTERNS_TEST_TOKEN has fewer than 8 characters");
    } finally {
      delete process.env.QA_INTERNS_TEST_TOKEN;
    }
  });
});

describe("redactor", () => {
  test("replace a value as written and in each JSON string escaping of it", () => {
    const redact = redactor(['pa"ss\\word']);
    const once = JSON.stringify({ password: 'pa"ss\\word' });
    const twice = JSON.stringify({ prompt: `Seed:\n${once}` });
    expect(redact('Sign in with pa"ss\\word.')).toBe("Sign in with [redacted].");
    expect(redact(once)).toBe('{"password":"[redacted]"}');
    expect(redact(twice)).toBe('{"prompt":"Seed:\\n{\\"password\\":\\"[redacted]\\"}"}');
  });

  test("replace a longer value before a value it contains", () => {
    expect(redactor(["sk_live_4f9a", "sk_live_4f9a1c2e7b"])("keys sk_live_4f9a1c2e7b and sk_live_4f9a")).toBe("keys [redacted] and [redacted]");
  });

  test("leave text without a listed value unchanged", () => {
    expect(redactor([])("owner@acme.test")).toBe("owner@acme.test");
  });
});

describe("redactJson", () => {
  test("replace values inside strings only, so keys and numbers stay and the JSON stays valid", () => {
    const value = { count: 12345678, steps: ["Send the key 12345678."], nested: { "12345678": "key 12345678" } };
    expect(redactJson(value, ["12345678"])).toEqual({ count: 12345678, steps: ["Send the key [redacted]."], nested: { "12345678": "key [redacted]" } });
  });
});

describe("redactFiles", () => {
  test("replace the bytes of each value in every file under the directories, text or not", async () => {
    const root = await scratch();
    const out = path.join(root, "interns", "i1", "out");
    await mkdir(path.join(out, "findings"), { recursive: true });
    await mkdir(path.join(out, "evidence"), { recursive: true });
    await writeFile(path.join(out, "findings", "key.json"), `${JSON.stringify({ observed: "The page shows sk_live_4f9a1c2e7b." })}\n`);
    await writeFile(path.join(out, "evidence", "dump.bin"), Buffer.concat([Buffer.from([0xff, 0x00]), Buffer.from("sk_live_4f9a1c2e7b"), Buffer.from([0xfe])]));
    await writeFile(path.join(root, "interns", "i1", "adapter.log"), "no secret here\n");
    await redactFiles([path.join(root, "interns"), path.join(root, "envs")], ["sk_live_4f9a1c2e7b"]);
    expect(await readFile(path.join(out, "findings", "key.json"), "utf8")).toBe('{"observed":"The page shows [redacted]."}\n');
    expect(await readFile(path.join(out, "evidence", "dump.bin"))).toEqual(Buffer.concat([Buffer.from([0xff, 0x00]), Buffer.from("[redacted]"), Buffer.from([0xfe])]));
    expect(await readFile(path.join(root, "interns", "i1", "adapter.log"), "utf8")).toBe("no secret here\n");
  });

  test("leave a file a symbolic link points to untouched, whether the link names the file or its directory", async () => {
    const root = await scratch();
    const outside = path.join(root, "home");
    await mkdir(outside);
    await writeFile(path.join(outside, ".profile"), "export TOKEN=sk_live_4f9a1c2e7b\n");
    const evidence = path.join(root, "interns", "i1", "out", "evidence");
    await mkdir(evidence, { recursive: true });
    await symlink(path.join(outside, ".profile"), path.join(evidence, "profile.txt"));
    await symlink(outside, path.join(evidence, "home"));
    await redactFiles([path.join(root, "interns")], ["sk_live_4f9a1c2e7b"]);
    expect(await readFile(path.join(outside, ".profile"), "utf8")).toBe("export TOKEN=sk_live_4f9a1c2e7b\n");
  });

  test.skipIf(asRoot)("fail on a file that holds a value and cannot be written, and leave a read-only file without one alone", async () => {
    const root = await scratch();
    const dir = path.join(root, "interns", "i1", "out");
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "clean.txt"), "nothing to remove\n");
    await chmod(path.join(dir, "clean.txt"), 0o444);
    await redactFiles([path.join(root, "interns")], ["sk_live_4f9a1c2e7b"]);
    await writeFile(path.join(dir, "held.txt"), "sk_live_4f9a1c2e7b\n");
    await chmod(path.join(dir, "held.txt"), 0o444);
    await expect(redactFiles([path.join(root, "interns")], ["sk_live_4f9a1c2e7b"])).rejects.toThrow("EACCES");
  });
});
