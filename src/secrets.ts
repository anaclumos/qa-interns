import { constants, existsSync } from "node:fs";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const marker = "[redacted]";
const minLength = 8;
const secrets = new Set<string>();
let cached: string[] | null = null;

function keep(found: { value: string; where: string }[]): void {
  for (const { value } of found) if (value.length >= minLength) secrets.add(value);
  cached = null;
  const short = found.find(({ value }) => value.length < minLength);
  if (short !== undefined) throw new Error(`${short.where} has fewer than ${minLength} characters, so removing it from the run directory would remove unrelated text too`);
}

export function keepHostSecrets(names: string[]): void {
  const found = names.map((name) => {
    const value = process.env[name];
    if (value === undefined) throw new Error(`customizations["qa-interns"].secrets.hostEnv names ${name}, which the environment of qa-interns does not set`);
    return { value, where: `The value of ${name}` };
  });
  keep(found.filter(({ value }) => value !== ""));
}

export function keepSeedSecrets(seed: unknown, fields: string[]): void {
  const named = new Set<string>();
  const found: { value: string; where: string }[] = [];
  const walk = (value: unknown, field: string | null): void => {
    if (typeof value === "string") {
      if (field !== null && value !== "") found.push({ value, where: `A value under the seed field ${field}` });
      return;
    }
    if (typeof value !== "object" || value === null) return;
    for (const [key, item] of Object.entries(value)) {
      const marked = !Array.isArray(value) && fields.includes(key);
      if (marked) named.add(key);
      walk(item, marked ? key : field);
    }
  };
  walk(seed, null);
  keep(found);
  const missing = fields.filter((field) => !named.has(field));
  if (missing.length > 0) throw new Error(`customizations["qa-interns"].secrets.seed names ${missing.join(", ")}, which the seed output has no field for`);
}

function forms(): string[] {
  const escape = (text: string) => JSON.stringify(text).slice(1, -1);
  cached ??= [...new Set([...secrets].flatMap((value) => [value, escape(value), escape(escape(value))]))].sort((a, b) => b.length - a.length);
  return cached;
}

function replace(text: string, list: string[]): string {
  return list.reduce((result, form) => result.replaceAll(form, marker), text);
}

export function hasSecrets(): boolean {
  return secrets.size > 0;
}

export function longestSecret(): number {
  return forms()[0]?.length ?? 0;
}

export function redact(text: string): string {
  return replace(text, forms());
}

export function redactJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value), (_key, item: unknown) => (typeof item === "string" ? redact(item) : item));
}

export async function redactFiles(dirs: string[]): Promise<void> {
  const list = forms().map((form) => Buffer.from(form).toString("latin1"));
  if (list.length === 0) return;
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile()) {
        const text = (await readFile(path, { flag: constants.O_RDONLY | constants.O_NOFOLLOW })).toString("latin1");
        const redacted = replace(text, list);
        if (redacted !== text) await writeFile(path, Buffer.from(redacted, "latin1"), { flag: constants.O_WRONLY | constants.O_TRUNC | constants.O_NOFOLLOW });
      }
    }
  };
  for (const dir of dirs) if (existsSync(dir)) await walk(dir);
}
