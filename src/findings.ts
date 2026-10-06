import { RequestError } from "@agentclientprotocol/sdk";
import { constants, existsSync } from "node:fs";
import { link, lstat, mkdir, open, readdir, readlink, realpath, stat, unlink, type FileHandle } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { kinds, type Confirmation, type Finding, type FindingEnvironment, type Rejected } from "./types.ts";

class Invalid extends Error {}

const maxBytes = 1024 ** 2;

const openFailures = new Map([
  ["ENOENT", "the file does not exist"],
  ["ELOOP", "the file is a symbolic link"],
  ["EACCES", "the file is not readable"],
  ["ENXIO", "the file is not a regular file"],
]);

const folderFailures = new Map([
  ["ENOTDIR", "the findings folder is a symbolic link or not a directory"],
  ["ELOOP", "the findings folder is a symbolic link or not a directory"],
  ["EACCES", "the findings folder is not readable"],
]);

export function errorCode(error: unknown): string | null {
  return z.object({ code: z.string() }).safeParse(error).data?.code ?? null;
}

export function message(error: unknown): string {
  if (error instanceof RequestError) return `${error.code}: ${error.message}${error.data === undefined ? "" : `: ${JSON.stringify(error.data)}`}`;
  return error instanceof Error ? error.message : String(error);
}

export function oneLine(text: string): string {
  return text.replaceAll("\r", " ").replaceAll("\n", " ");
}

function control(char: string): boolean {
  const code = char.codePointAt(0) ?? 0;
  return code < 0x20 || (code >= 0x7f && code <= 0x9f) || (code >= 0x2028 && code <= 0x202e) || (code >= 0x2066 && code <= 0x2069);
}

export function stripControl(text: string): string {
  return [...text].filter((char) => char === "\n" || char === "\t" || !control(char)).join("");
}

export async function readAgentFile(file: string): Promise<string> {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK).catch((error: unknown) => {
    const reason = openFailures.get(errorCode(error) ?? "");
    throw reason === undefined ? error : new Invalid(reason);
  });
  try {
    if (!(await handle.stat()).isFile()) throw new Invalid("the file is not a regular file");
    const buffer = Buffer.alloc(maxBytes + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    if (length > maxBytes) throw new Invalid("the file is above the limit of 1 MiB");
    return buffer.toString("utf8", 0, length);
  } finally {
    await handle.close();
  }
}

function required(message: string) {
  return (issue: z.core.$ZodRawIssue) => (issue.input === undefined ? "is required" : message);
}

function fields(message: string, allowed: string[]) {
  return (issue: z.core.$ZodRawIssue) => {
    if (issue.code === "unrecognized_keys") return `has unknown fields ${issue.keys.join(", ")} (the allowed fields are ${allowed.join(", ")})`;
    return required(message)(issue);
  };
}

const text = z.preprocess(
  (value) => (typeof value === "string" ? stripControl(value) : value),
  z.string({ error: required("must be a non-empty string") }).min(1, { error: "must be a non-empty string" }),
);

const paths = z.array(text, { error: required("must be an array of paths") });

const conditionFields = ["account", "data", "viewport", "browser", "network"];

const findingFields = ["title", "kind", "conditions", "steps", "observed", "contradicts", "evidence"];

const findingSchema = z.strictObject(
  {
    title: text.refine((value) => !value.includes("\n"), { error: "must be one line" }),
    kind: z.enum(kinds, { error: required(`must be one of ${kinds.join(", ")}`) }),
    conditions: z.strictObject(
      { account: text, data: text, viewport: text, browser: text, network: text },
      { error: fields(`must be an object with the fields ${conditionFields.join(", ")}`, conditionFields) },
    ),
    steps: z.array(text, { error: required("must be an array of strings") }).min(1, { error: "must have at least one entry" }),
    observed: text,
    contradicts: text.nullable().optional(),
    evidence: paths,
  },
  { error: fields("must be one JSON object", findingFields) },
);

const confirmationFields = ["steps", "task", "observed", "evidence"];

const verdict = z.boolean({ error: required("must be true or false") });

export const confirmationSchema = z.strictObject(
  { steps: verdict, task: verdict, observed: text, evidence: paths },
  { error: fields("must be one JSON object", confirmationFields) },
);

const groupsSchema = z.strictObject(
  {
    groups: z.array(z.array(text, { error: required("must be an array of finding ids") }).min(1, { error: "must have at least one finding id" }), {
      error: required("must be an array of groups, each an array of finding ids"),
    }),
  },
  { error: fields("must be one JSON object with the field groups", ["groups"]) },
);

function where(keys: PropertyKey[]) {
  return keys.length === 0 ? "the file" : z.core.toDotPath(keys);
}

function parse<T>(schema: z.ZodType<T>, raw: string): T {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    if (err instanceof SyntaxError) throw new Invalid(`not valid JSON: ${err.message}`);
    throw err;
  }
  const result = schema.safeParse(data);
  if (!result.success) throw new Invalid(result.error.issues.map((issue) => `${where(issue.path)} ${issue.message}`).join("; "));
  return result.data;
}

function inside(dir: string, file: string) {
  const relative = path.relative(dir, file);
  return relative !== "" && relative !== ".." && !relative.startsWith("../") && !path.isAbsolute(relative);
}

export function outDir(intern: string, attempt: number): string {
  return path.join("interns", intern, attempt === 1 ? "out" : `out-${attempt}`);
}

async function evidence(runDir: string, out: string, list: string[]) {
  const dir = path.join(runDir, out);
  const realOut = await realpath(dir);
  const problems: string[] = [];
  const resolved: string[] = [];
  for (const entry of list) {
    const relative = path.isAbsolute(entry) ? (entry.startsWith("/qa/out/") ? entry.slice("/qa/out/".length) : null) : entry;
    const file = relative === null ? null : path.resolve(dir, relative);
    if (file === null || !inside(dir, file)) {
      problems.push(`evidence path ${entry} is outside /qa/out`);
      continue;
    }
    if (!existsSync(file)) {
      problems.push(`evidence path ${entry} does not exist`);
      continue;
    }
    const real = await realpath(file);
    if (!inside(realOut, real)) {
      problems.push(`evidence path ${entry} resolves outside /qa/out`);
      continue;
    }
    if (!(await stat(real)).isFile()) {
      problems.push(`evidence path ${entry} is not a file`);
      continue;
    }
    const within = path.relative(realOut, real);
    if ([...within].some(control)) {
      problems.push(`evidence path ${entry} resolves to a path with a control character`);
      continue;
    }
    resolved.push(path.join(out, within));
  }
  if (problems.length > 0) throw new Invalid(problems.join("; "));
  return resolved;
}

export async function readFindings(
  runDir: string,
  intern: string,
  attempt: number,
  environment: FindingEnvironment,
): Promise<{ findings: Finding[]; rejected: Rejected[] }> {
  const out = outDir(intern, attempt);
  const folder = path.join(out, "findings");
  const prefix = attempt === 1 ? intern : path.relative("interns", out);
  const findings: Finding[] = [];
  const rejected: Rejected[] = [];
  let handle: FileHandle | null = null;
  try {
    let names: string[];
    try {
      handle = await open(path.join(runDir, folder), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      names = (await readdir(`/proc/self/fd/${handle.fd}`)).filter((name) => name.endsWith(".json")).sort();
    } catch (error) {
      const code = errorCode(error);
      if (code === "ENOENT") return { findings, rejected };
      const reason = folderFailures.get(code ?? "");
      if (reason === undefined) throw error;
      rejected.push({ intern, file: folder, reason });
      return { findings, rejected };
    }
    for (const name of names) {
      const file = path.join(folder, name);
      try {
        if ([...name].some(control)) throw new Invalid("the file name contains a control character");
        const data = parse(findingSchema, await readAgentFile(`/proc/self/fd/${handle.fd}/${name}`));
        const contradicts = data.contradicts ?? null;
        if (data.kind === "inconsistency" && contradicts === null) throw new Invalid("contradicts is required when kind is inconsistency");
        findings.push({
          id: `${prefix}/${name.slice(0, -".json".length)}`,
          intern,
          title: data.title,
          kind: data.kind,
          conditions: data.conditions,
          steps: data.steps,
          observed: data.observed,
          contradicts,
          evidence: await evidence(runDir, out, data.evidence),
          environment,
        });
      } catch (err) {
        if (!(err instanceof Invalid)) throw err;
        rejected.push({ intern, file, reason: err.message });
      }
    }
  } finally {
    await handle?.close();
  }
  return { findings, rejected };
}

export function parseGroups(raw: string, ids: string[]): string[][] {
  const { groups } = parse(groupsSchema, raw);
  const counts = new Map<string, number>();
  for (const id of groups.flat()) counts.set(id, (counts.get(id) ?? 0) + 1);
  const problems: string[] = [];
  for (const [id, count] of counts) {
    if (!ids.includes(id)) problems.push(`finding id ${id} is not one of the listed findings`);
    else if (count > 1) problems.push(`finding id ${id} appears ${count === 2 ? "twice" : `${count} times`}`);
  }
  for (const id of ids) if (!counts.has(id)) problems.push(`finding id ${id} is missing`);
  if (problems.length > 0) throw new Invalid(problems.join("; "));
  return groups;
}

export async function readConfirmation(runDir: string, intern: string, attempt: number): Promise<Confirmation> {
  const out = outDir(intern, attempt);
  const data = parse(confirmationSchema, await readAgentFile(path.join(runDir, out, "confirmation.json")));
  return { steps: data.steps, task: data.task, observed: data.observed, evidence: await evidence(runDir, out, data.evidence) };
}

const linkFailures = new Map([
  ...openFailures,
  ["ENOTDIR", "a folder in the path is not a directory"],
  ["ENAMETOOLONG", "the path is too long"],
  ["EXDEV", "the file is on another file system"],
  ["EMLINK", "the file has too many links"],
  ["EEXIST", "another listed path names the same file"],
]);

function linkFailure(error: unknown): string {
  const reason = linkFailures.get(errorCode(error) ?? "");
  if (reason === undefined) throw error;
  return reason;
}

export async function linkEvidence(runDir: string, entry: string, target: string): Promise<string | null> {
  if (entry.split("/").includes("..")) return "the path has a .. component";
  const expected = path.join(await realpath(runDir), entry);
  let handle: FileHandle;
  try {
    handle = await open(path.join(runDir, entry), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    return linkFailure(error);
  }
  try {
    if ((await readlink(`/proc/self/fd/${handle.fd}`)) !== expected) return "its real path is not the listed path";
    const file = await handle.stat();
    if (!file.isFile()) return "the file is not a regular file";
    try {
      await mkdir(path.dirname(target), { recursive: true });
      await link(expected, target);
    } catch (error) {
      return linkFailure(error);
    }
    const linked = await lstat(target);
    if (linked.dev === file.dev && linked.ino === file.ino) return null;
    await unlink(target);
    return "the file changed while QA Interns linked it";
  } finally {
    await handle.close();
  }
}
