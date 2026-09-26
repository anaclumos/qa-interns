import { constants, existsSync } from "node:fs";
import { lstat, open, readdir, realpath, stat } from "node:fs/promises";
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

function errorCode(error: unknown): string | null {
  return error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : null;
}

export async function readAgentFile(file: string): Promise<string> {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK).catch((error: unknown) => {
    const reason = openFailures.get(errorCode(error) ?? "");
    throw reason === undefined ? error : new Invalid(reason);
  });
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new Invalid("the file is not a regular file");
    if (info.size > maxBytes) throw new Invalid(`the file is ${info.size} bytes, above the limit of 1 MiB`);
    return await handle.readFile("utf8");
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

const text = z.string({ error: required("must be a non-empty string") }).min(1, { error: "must be a non-empty string" });

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

const confirmationFields = ["reproduced", "observed", "evidence"];

const confirmationSchema = z.strictObject(
  { reproduced: z.boolean({ error: required("must be true or false") }), observed: text, evidence: paths },
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
  if (keys.length === 0) return "the file";
  return keys.map((key, index) => (typeof key === "number" ? `[${key}]` : index === 0 ? String(key) : `.${String(key)}`)).join("");
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

async function evidence(runDir: string, intern: string, list: string[]) {
  const out = path.join(runDir, "interns", intern, "out");
  const realOut = await realpath(out);
  const problems: string[] = [];
  const resolved: string[] = [];
  for (const entry of list) {
    const relative = path.isAbsolute(entry) ? (entry.startsWith("/qa/out/") ? entry.slice("/qa/out/".length) : null) : entry;
    const file = relative === null ? null : path.resolve(out, relative);
    if (file === null || !inside(out, file)) {
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
    resolved.push(path.join("interns", intern, "out", path.relative(realOut, real)));
  }
  if (problems.length > 0) throw new Invalid(problems.join("; "));
  return resolved;
}

export async function readFindings(
  runDir: string,
  intern: string,
  environment: FindingEnvironment,
): Promise<{ findings: Finding[]; rejected: Rejected[] }> {
  const folder = path.join("interns", intern, "out", "findings");
  const dir = path.join(runDir, folder);
  const findings: Finding[] = [];
  const rejected: Rejected[] = [];
  const info = await lstat(dir).catch((error: unknown) => {
    if (errorCode(error) === "ENOENT") return null;
    throw error;
  });
  if (info === null) return { findings, rejected };
  if (!info.isDirectory()) {
    rejected.push({ intern, file: folder, reason: `the findings folder is ${info.isSymbolicLink() ? "a symbolic link" : "not a directory"}` });
    return { findings, rejected };
  }
  const names = (await readdir(dir)).filter((name) => name.endsWith(".json")).sort();
  for (const name of names) {
    const file = path.join(folder, name);
    try {
      const data = parse(findingSchema, await readAgentFile(path.join(dir, name)));
      const contradicts = data.contradicts ?? null;
      if (data.kind === "inconsistency" && contradicts === null) throw new Invalid("contradicts is required when kind is inconsistency");
      findings.push({
        id: `${intern}/${name.slice(0, -".json".length)}`,
        intern,
        title: data.title,
        kind: data.kind,
        conditions: data.conditions,
        steps: data.steps,
        observed: data.observed,
        contradicts,
        evidence: await evidence(runDir, intern, data.evidence),
        environment,
      });
    } catch (err) {
      if (!(err instanceof Invalid)) throw err;
      rejected.push({ intern, file, reason: err.message });
    }
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

export async function readConfirmation(runDir: string, intern: string): Promise<Confirmation> {
  const data = parse(confirmationSchema, await readAgentFile(path.join(runDir, "interns", intern, "out", "confirmation.json")));
  return { reproduced: data.reproduced, observed: data.observed, evidence: await evidence(runDir, intern, data.evidence) };
}
