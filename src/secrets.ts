import { constants, existsSync } from "node:fs";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const marker = "[redacted]";
const minLength = 8;
const secrets = new Set<string>();
let cached: string[] | null = null;

function keep(found: { value: string; where: string }[]): string | null {
  for (const { value } of found) if (value.length >= minLength) secrets.add(value);
  cached = null;
  const short = found.find(({ value }) => value.length < minLength);
  return short === undefined ? null : `${short.where} has fewer than ${minLength} characters, so removing it from the run directory would remove unrelated text too`;
}

export function keepHostSecrets(names: string[]): string | null {
  const found = names.map((name) => {
    const value = process.env[name];
    if (value === undefined) throw new Error(`customizations["qa-interns"].secrets.hostEnv names ${name}, which the environment of qa-interns does not set`);
    return { value, where: `The value of ${name}` };
  });
  return keep(found.filter(({ value }) => value !== ""));
}

export function keepSeedSecrets(seed: unknown, fields: string[]): string | null {
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
  const short = keep(found);
  const missing = fields.filter((field) => !named.has(field));
  return missing.length > 0 ? `customizations["qa-interns"].secrets.seed names ${missing.join(", ")}, which the seed output has no field for` : short;
}

function forms(): string[] {
  const escape = (text: string) => JSON.stringify(text).slice(1, -1);
  cached ??= [...new Set([...secrets].flatMap((value) => [value, escape(value), escape(escape(value))]))].sort((a, b) => b.length - a.length);
  return cached;
}

function replace(text: string, list: string[]): string {
  return list.reduce((result, form) => result.replaceAll(form, marker), text);
}

export function forgetSecrets(): void {
  secrets.clear();
  cached = null;
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

export function redactAcross(parts: { text: string }[]): void {
  const joined = parts.map((part) => part.text).join("");
  const spans: { start: number; end: number }[] = [];
  for (const form of forms()) {
    for (let start = joined.indexOf(form); start !== -1; start = joined.indexOf(form, start + form.length)) {
      const end = start + form.length;
      if (!spans.some((span) => start < span.end && span.start < end)) spans.push({ start, end });
    }
  }
  if (spans.length === 0) return;
  let offset = 0;
  for (const part of parts) {
    const { length } = part.text;
    let out = "";
    for (let index = offset; index < offset + length; index += 1) {
      const span = spans.find((entry) => entry.start <= index && index < entry.end);
      if (span === undefined) out += joined[index];
      else if (span.start === index) out += marker;
    }
    part.text = out;
    offset += length;
  }
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
