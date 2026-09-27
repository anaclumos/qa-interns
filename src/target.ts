import type { Subprocess } from "bun";
import { existsSync } from "node:fs";
import { appendFile, mkdir, realpath } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { z } from "zod";

export type QaSettings = { urls: Record<string, string>; ready: string; seed: string; focus: string[]; offLimits: string[] };
export type TargetRef = { repo: string; path: string; commit: string };
export type ComposeService = {
  build: boolean;
  memLimit: number | null;
  networkMode: string | null;
  aliases: string[];
  hasCpus: boolean;
  hasPidsLimit: boolean;
  deployLimits: boolean;
  replicas: number;
  active: boolean;
};
export type Target = TargetRef & {
  settings: QaSettings;
  config: Record<string, unknown>;
  composeFiles: string[];
  service: string;
  services: Record<string, ComposeService>;
};

type CommandOptions = { env?: Record<string, string | undefined>; log?: string; timeout?: number };

const running = new Set<Subprocess>();

export function killCommands(): void {
  for (const proc of running) proc.kill();
}

export function track<T extends Subprocess>(proc: T): T {
  running.add(proc);
  proc.exited.then(() => running.delete(proc));
  return proc;
}

export async function capture(cmd: string[], options: CommandOptions = {}): Promise<{ code: number; stdout: string; stderr: string }> {
  const argv = options.timeout === undefined ? cmd : ["timeout", "--kill-after=10s", `${options.timeout / 1000}s`, ...cmd];
  const started = performance.now();
  const proc = track(Bun.spawn(argv, { env: options.env, stdin: "ignore", stdout: "pipe", stderr: "pipe" }));
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  if (options.log !== undefined) await appendFile(options.log, stderr);
  if (options.timeout !== undefined && (code === 124 || code === 137) && performance.now() - started >= options.timeout) {
    throw new Error(`${cmd.join(" ")} timed out after ${options.timeout / 1000} seconds: ${stderr.trim().slice(-2000)}`);
  }
  return { code, stdout, stderr };
}

export function failure(cmd: string[], code: number, stderr: string): Error {
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
      networks: z.record(z.string(), z.object({ aliases: z.array(z.string()).optional() }).nullable()).optional(),
      mem_limit: z.string().optional(),
      cpus: z.number().optional(),
      pids_limit: z.number().optional(),
      deploy: z.object({ replicas: z.number().optional(), resources: z.object({ limits: limitsSchema.optional() }).optional() }).optional(),
      profiles: z.array(z.string()).optional(),
      depends_on: z.record(z.string(), z.object({ required: z.boolean().optional() })).optional(),
      privileged: z.boolean().optional(),
      pid: z.string().optional(),
      ipc: z.string().optional(),
      userns_mode: z.string().optional(),
      devices: z.array(z.object({ source: z.string() })).optional(),
      cap_add: z.array(z.string()).optional(),
      security_opt: z.array(z.string()).optional(),
      volumes: z.array(z.object({ type: z.string(), source: z.string().optional() })).optional(),
    }),
  ),
  volumes: z.record(z.string(), z.object({ name: z.string(), external: z.boolean().optional() })).optional(),
  networks: z.record(z.string(), z.object({ name: z.string(), external: z.boolean().optional() })).optional(),
});

const reservedServices = ["qa-proxy", "qa-runner"];

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
  const archive = track(Bun.spawn(archiveCmd, { stdin: "ignore", stdout: "pipe", stderr: "pipe" }));
  const extract = track(Bun.spawn(extractCmd, { stdin: archive.stdout, stdout: "ignore", stderr: "pipe" }));
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

function within(dir: string, file: string): boolean {
  const path = relative(dir, file);
  return path !== ".." && !path.startsWith("../");
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
  const { dockerComposeFile, service, runServices } = parsed.data;
  const composeFiles = typeof dockerComposeFile === "string" ? [dockerComposeFile] : dockerComposeFile;
  const root = await realpath(sourceDir);
  for (const entry of composeFiles) {
    const path = resolve(sourceDir, ".devcontainer", entry);
    if (!within(sourceDir, path) || (existsSync(path) && !within(root, await realpath(path)))) {
      throw new Error(`${file} names the Compose file ${entry}, which resolves outside the target directory`);
    }
  }
  const files = composeFiles.flatMap((entry) => ["-f", resolve(sourceDir, ".devcontainer", entry)]);
  const checkProject = `qa-check-${crypto.randomUUID().slice(0, 8)}`;
  const output = await execute(["docker", "compose", "-p", checkProject, ...files, "--profile", "*", "config", "--format", "json"]);
  const project = composeSchema.parse(JSON.parse(output));
  if (!Object.hasOwn(project.services, service)) throw new Error(`${file} names service ${service}, which is not in its Compose files`);

  const started =
    runServices === undefined
      ? Object.entries(project.services)
          .filter(([name, entry]) => (entry.profiles ?? []).length === 0 || name === service)
          .map(([name]) => name)
      : [service, ...runServices];
  const starts = new Set<string>();
  const start = (name: string) => {
    if (starts.has(name)) return;
    starts.add(name);
    for (const [dependency, condition] of Object.entries(project.services[name]?.depends_on ?? {})) {
      if (condition.required !== false || (project.services[dependency]?.profiles ?? []).length === 0) start(dependency);
    }
  };
  started.forEach(start);
  const violations: string[] = [];
  const services: Record<string, ComposeService> = {};
  const tags = new Map<string, string>();
  const aliasOwners = new Map<string, string>();
  for (const [name, entry] of Object.entries(project.services)) {
    if (reservedServices.includes(name)) violations.push(`service ${name} uses a name QA Interns reserves`);
    if (entry.container_name !== undefined) violations.push(`service ${name} sets container_name ${entry.container_name}`);
    if (entry.network_mode !== undefined && !entry.network_mode.startsWith("service:")) {
      violations.push(`service ${name} sets network_mode ${entry.network_mode}`);
    }
    if (entry.privileged === true) violations.push(`service ${name} sets privileged`);
    if (entry.pid === "host") violations.push(`service ${name} sets pid host`);
    if (entry.ipc === "host") violations.push(`service ${name} sets ipc host`);
    if (entry.userns_mode === "host") violations.push(`service ${name} sets userns_mode host`);
    for (const device of entry.devices ?? []) violations.push(`service ${name} maps device ${device.source}`);
    for (const capability of entry.cap_add ?? []) violations.push(`service ${name} adds capability ${capability}`);
    for (const option of entry.security_opt ?? []) {
      if (option.includes("unconfined")) violations.push(`service ${name} sets security_opt ${option}`);
    }
    for (const volume of entry.volumes ?? []) {
      if (volume.type !== "bind" || volume.source === undefined) continue;
      const exists = existsSync(volume.source);
      const real = exists ? await realpath(volume.source) : resolve(volume.source);
      if (!within(exists ? root : sourceDir, real)) violations.push(`service ${name} mounts ${volume.source}, which resolves to ${real}, outside the target directory`);
    }
    const aliases = [...new Set(Object.values(entry.networks ?? {}).flatMap((network) => network?.aliases ?? []))];
    for (const alias of aliases) {
      const key = alias.toLowerCase();
      if (reservedServices.includes(key)) violations.push(`service ${name} declares network alias ${alias}, a name QA Interns reserves`);
      else if (key !== name.toLowerCase() && Object.keys(project.services).some((other) => other.toLowerCase() === key)) {
        violations.push(`service ${name} declares network alias ${alias}, the name of another service`);
      }
      const owner = aliasOwners.get(key);
      if (owner === undefined) aliasOwners.set(key, name);
      else violations.push(`services ${owner} and ${name} both declare network alias ${alias}`);
    }
    const other = tags.get(name.toLowerCase());
    if (other === undefined) tags.set(name.toLowerCase(), name);
    else violations.push(`services ${other} and ${name} differ only by case, so their names and prebuilt image tags collide`);
    const active = starts.has(name);
    const limits = entry.deploy?.resources?.limits;
    const memory = entry.mem_limit ?? limits?.memory;
    services[name] = {
      build: entry.build !== undefined,
      memLimit: memory === undefined ? null : bytes(memory, `The memory limit of service ${name}`),
      networkMode: entry.network_mode ?? null,
      aliases,
      hasCpus: (entry.cpus ?? 0) > 0 || (limits?.cpus ?? 0) > 0,
      hasPidsLimit: (entry.pids_limit ?? 0) > 0 || (limits?.pids ?? 0) > 0,
      deployLimits: limits !== undefined,
      replicas: entry.deploy?.replicas ?? 1,
      active,
    };
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
  return { ...ref, settings: parsed.data.customizations["qa-interns"], config, composeFiles, service, services };
}
