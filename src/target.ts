import { appendFile, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { z } from "zod";

export type QaSettings = { urls: Record<string, string>; ready: string; seed: string; focus: string[]; offLimits: string[] };
export type TargetRef = { repo: string; path: string; commit: string };
export type ComposeService = {
  build: boolean;
  memLimit: number | null;
  networkMode: string | null;
  hasCpus: boolean;
  hasPidsLimit: boolean;
  deployLimits: boolean;
};
export type Target = TargetRef & {
  settings: QaSettings;
  config: Record<string, unknown>;
  composeFiles: string[];
  service: string;
  services: Record<string, ComposeService>;
};

type CommandOptions = { env?: Record<string, string | undefined>; log?: string };

export async function capture(cmd: string[], options: CommandOptions = {}): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(cmd, { env: options.env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  if (options.log !== undefined) await appendFile(options.log, stderr);
  return { code, stdout, stderr };
}

function failure(cmd: string[], code: number, stderr: string): Error {
  return new Error(`${cmd.join(" ")} exited with ${code}: ${stderr.trim().slice(-2000)}`);
}

export async function execute(cmd: string[], options: CommandOptions = {}): Promise<string> {
  const result = await capture(cmd, options);
  if (result.code !== 0) throw failure(cmd, result.code, result.stderr);
  return result.stdout;
}

export function isHttpUrl(value: string): boolean {
  return URL.canParse(value) && ["http:", "https:"].includes(new URL(value).protocol);
}

const settingsSchema = z.strictObject({
  urls: z
    .record(z.string(), z.string().refine(isHttpUrl, "must be an http: or https: URL"))
    .refine((urls) => Object.keys(urls).length > 0, "must name at least one URL"),
  ready: z.string().min(1),
  seed: z.string().min(1),
  focus: z.array(z.string().min(1)).default([]),
  offLimits: z.array(z.string().min(1)).default([]),
});

const configSchema = z.object({
  dockerComposeFile: z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]),
  service: z.string().min(1),
  runServices: z.array(z.string().min(1)).optional(),
  customizations: z.object({ "qa-interns": settingsSchema }),
});

const limitsSchema = z.object({ memory: z.string().optional(), cpus: z.number().optional(), pids: z.number().optional() });

const composeSchema = z.object({
  services: z.record(
    z.string(),
    z.object({
      build: z.unknown().optional(),
      container_name: z.string().optional(),
      network_mode: z.string().optional(),
      mem_limit: z.string().optional(),
      cpus: z.number().optional(),
      pids_limit: z.number().optional(),
      deploy: z.object({ resources: z.object({ limits: limitsSchema.optional() }).optional() }).optional(),
    }),
  ),
  volumes: z.record(z.string(), z.object({ name: z.string(), external: z.boolean().optional() })).optional(),
  networks: z.record(z.string(), z.object({ name: z.string(), external: z.boolean().optional() })).optional(),
});

const checkProject = "qa-interns-check";

export async function resolveTarget(dir: string, rev: string): Promise<TargetRef> {
  const git = ["git", "-C", dir, "rev-parse"];
  const repo = (await execute([...git, "--show-toplevel"])).trim();
  const prefix = (await execute([...git, "--show-prefix"])).trim();
  const commit = (await execute([...git, "--verify", "--end-of-options", `${rev}^{commit}`])).trim();
  return { repo, path: prefix.endsWith("/") ? prefix.slice(0, -1) : prefix, commit };
}

export async function exportTree(ref: TargetRef, dest: string): Promise<void> {
  await mkdir(dest, { recursive: true });
  const archiveCmd = ["git", "-C", ref.repo, "archive", "--format=tar", `${ref.commit}:${ref.path}`];
  const extractCmd = ["tar", "-x", "-C", dest];
  const archive = Bun.spawn(archiveCmd, { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const extract = Bun.spawn(extractCmd, { stdin: archive.stdout, stdout: "ignore", stderr: "pipe" });
  const [archiveCode, archiveErr, extractCode, extractErr] = await Promise.all([
    archive.exited,
    new Response(archive.stderr).text(),
    extract.exited,
    new Response(extract.stderr).text(),
  ]);
  if (archiveCode !== 0) throw failure(archiveCmd, archiveCode, archiveErr);
  if (extractCode !== 0) throw failure(extractCmd, extractCode, extractErr);
}

function bytes(value: string, where: string): number {
  const size = Number(value);
  if (!Number.isSafeInteger(size) || size <= 0) throw new Error(`${where} is ${value}, not a byte count`);
  return size;
}

export async function loadTarget(ref: TargetRef, sourceDir: string): Promise<Target> {
  const file = join(sourceDir, ".devcontainer", "devcontainer.json");
  const object = z.record(z.string(), z.unknown()).safeParse(Bun.JSONC.parse(await Bun.file(file).text()));
  if (!object.success) throw new Error(`${file} is not a JSON object`);
  const config = object.data;
  if (config.dockerComposeFile === undefined) {
    throw new Error(`${file} has no dockerComposeFile. Single-container dev containers are not supported yet; use a Docker Compose dev container.`);
  }
  const parsed = configSchema.safeParse(config);
  if (!parsed.success) throw new Error(`${file} is invalid:\n${z.prettifyError(parsed.error)}`);
  const { dockerComposeFile, service } = parsed.data;
  const composeFiles = typeof dockerComposeFile === "string" ? [dockerComposeFile] : dockerComposeFile;
  const files = composeFiles.flatMap((entry) => ["-f", resolve(sourceDir, ".devcontainer", entry)]);
  const output = await execute(["docker", "compose", "-p", checkProject, ...files, "--profile", "*", "config", "--format", "json"]);
  const project = composeSchema.parse(JSON.parse(output));
  if (!Object.hasOwn(project.services, service)) throw new Error(`${file} names service ${service}, which is not in its Compose files`);

  const violations: string[] = [];
  for (const [name, entry] of Object.entries(project.services)) {
    if (entry.container_name !== undefined) violations.push(`service ${name} sets container_name ${entry.container_name}`);
    if (entry.network_mode !== undefined && !entry.network_mode.startsWith("service:")) {
      violations.push(`service ${name} sets network_mode ${entry.network_mode}`);
    }
  }
  for (const [kind, entries] of [
    ["volume", project.volumes ?? {}],
    ["network", project.networks ?? {}],
  ] as const) {
    for (const [key, entry] of Object.entries(entries)) {
      if (entry.external === true) violations.push(`${kind} ${key} is external (${entry.name})`);
      else if (entry.name !== `${checkProject}_${key}`) violations.push(`${kind} ${key} sets name ${entry.name}`);
    }
  }
  if (violations.length > 0) {
    throw new Error(`The Compose files of ${file} cannot run as isolated copies:\n${violations.map((line) => `- ${line}`).join("\n")}`);
  }

  const services: Record<string, ComposeService> = {};
  for (const [name, entry] of Object.entries(project.services)) {
    const limits = entry.deploy?.resources?.limits;
    const memory = entry.mem_limit ?? limits?.memory;
    services[name] = {
      build: entry.build !== undefined,
      memLimit: memory === undefined ? null : bytes(memory, `The memory limit of service ${name}`),
      networkMode: entry.network_mode ?? null,
      hasCpus: entry.cpus !== undefined || limits?.cpus !== undefined,
      hasPidsLimit: entry.pids_limit !== undefined || limits?.pids !== undefined,
      deployLimits: limits !== undefined,
    };
  }
  return { ...ref, settings: parsed.data.customizations["qa-interns"], config, composeFiles, service, services };
}
