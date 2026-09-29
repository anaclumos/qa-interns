import { constants, existsSync } from "node:fs";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const marker = "[redacted]";
const minLength = 8;

function checked(value: string, where: string): string {
  if (value.length < minLength) throw new Error(`${where} has fewer than ${minLength} characters, so removing it from the run directory would remove unrelated text too`);
  return value;
}

export function hostSecrets(names: string[]): string[] {
  return names.flatMap((name) => {
    const value = process.env[name];
    if (value === undefined) throw new Error(`customizations["qa-interns"].secrets.hostEnv names ${name}, which the environment of qa-interns does not set`);
    return value === "" ? [] : [checked(value, `The value of ${name}`)];
  });
}

export function seedSecrets(seed: unknown, fields: string[]): string[] {
  const found = new Set<string>();
  const values: string[] = [];
  const walk = (value: unknown, field: string | null): void => {
    if (typeof value === "string") {
      if (field !== null && value !== "") values.push(checked(value, `A value under the seed field ${field}`));
      return;
    }
    if (typeof value !== "object" || value === null) return;
    for (const [key, item] of Object.entries(value)) {
      const marked = !Array.isArray(value) && fields.includes(key);
      if (marked) found.add(key);
      walk(item, marked ? key : field);
    }
  };
  walk(seed, null);
  const missing = fields.filter((field) => !found.has(field));
  if (missing.length > 0) throw new Error(`customizations["qa-interns"].secrets.seed names ${missing.join(", ")}, which the seed output has no field for`);
  return values;
}

function forms(secrets: Iterable<string>): string[] {
  const escape = (text: string) => JSON.stringify(text).slice(1, -1);
  const all = [...secrets].flatMap((value) => [value, escape(value), escape(escape(value))]);
  return [...new Set(all)].sort((a, b) => b.length - a.length);
}

function replace(text: string, list: string[]): string {
  return list.reduce((result, form) => result.replaceAll(form, marker), text);
}

export function redactor(secrets: Iterable<string>): (text: string) => string {
  const list = forms(secrets);
  return (text) => replace(text, list);
}

export function redactJson<T>(value: T, secrets: Iterable<string>): T {
  const redact = redactor(secrets);
  return JSON.parse(JSON.stringify(value), (_key, item: unknown) => (typeof item === "string" ? redact(item) : item));
}

export async function redactFiles(dirs: string[], secrets: Iterable<string>): Promise<void> {
  const list = forms(secrets).map((form) => Buffer.from(form).toString("latin1"));
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
