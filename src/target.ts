import type { Subprocess } from "bun";
import { appendFile, mkdir, readlink, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
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
const hooksSchema = z.array(z.object({ privileged: z.boolean().optional() })).optional();
const filesSchema = z.record(z.string(), z.object({ file: z.string().optional() })).optional();

const buildSchema = z.object({
  context: z.string(),
  dockerfile: z.string().optional(),
  additional_contexts: z.record(z.string(), z.string()).optional(),
  network: z.string().optional(),
  privileged: z.boolean().optional(),
  entitlements: z.array(z.string()).optional(),
  ssh: z.array(z.string()).optional(),
  cache_from: z.array(z.string()).optional(),
  cache_to: z.array(z.string()).optional(),
});

const composeSchema = z.object({
  services: z.record(
    z.string(),
    z.object({
      build: buildSchema.optional(),
      container_name: z.string().optional(),
      network_mode: z.string().optional(),
      networks: z.record(z.string(), z.object({ aliases: z.array(z.string()).optional() }).nullable()).optional(),
      mem_limit: z.string().optional(),
      cpus: z.number().optional(),
      pids_limit: z.number().optional(),
      deploy: z
        .object({
          replicas: z.number().optional(),
          resources: z.object({ limits: limitsSchema.optional(), reservations: z.object({ devices: z.array(z.unknown()).optional() }).optional() }).optional(),
        })
        .optional(),
      profiles: z.array(z.string()).optional(),
      depends_on: z.record(z.string(), z.object({ required: z.boolean().optional() })).optional(),
      privileged: z.boolean().optional(),
      pid: z.string().optional(),
      ipc: z.string().optional(),
      uts: z.string().optional(),
      cgroup: z.string().optional(),
      userns_mode: z.string().optional(),
      devices: z.array(z.object({ source: z.string() })).optional(),
      device_cgroup_rules: z.array(z.string()).optional(),
      gpus: z.array(z.unknown()).optional(),
      cap_add: z.array(z.string()).optional(),
      security_opt: z.array(z.string()).optional(),
      use_api_socket: z.boolean().optional(),
      volumes: z.array(z.object({ type: z.string(), source: z.string().optional() })).optional(),
      volumes_from: z.array(z.string()).optional(),
      pre_start: hooksSchema,
      post_start: hooksSchema,
      pre_stop: hooksSchema,
    }),
  ),
  volumes: z
    .record(z.string(), z.object({ name: z.string(), external: z.boolean().optional(), driver: z.string().optional(), driver_opts: z.record(z.string(), z.unknown()).optional() }))
    .optional(),
  networks: z.record(z.string(), z.object({ name: z.string(), external: z.boolean().optional() })).optional(),
  secrets: filesSchema,
  configs: filesSchema,
});

const envFilesSchema = z.object({ services: z.record(z.string(), z.object({ env_file: z.array(z.object({ path: z.string() })).optional() })) });

type ComposeProject = z.infer<typeof composeSchema>;

const reservedServices = ["qa-proxy", "qa-runner"];
const namespaces = ["pid", "ipc", "uts", "cgroup", "userns_mode"] as const;
const hooks = ["pre_start", "post_start", "pre_stop"] as const;
const buildNetworks = ["default", "none"];

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

function hasCode(error: unknown, codes: string[]): boolean {
  return error instanceof Error && "code" in error && typeof error.code === "string" && codes.includes(error.code);
}

async function resolveReal(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch (error) {
    if (!hasCode(error, ["ENOENT"])) throw error;
  }
  const entry = join(await resolveReal(dirname(path)), basename(path));
  const link = await readlink(entry).catch((error: unknown) => {
    if (hasCode(error, ["ENOENT", "EINVAL"])) return null;
    throw error;
  });
  return link === null ? entry : resolveReal(resolve(dirname(entry), link));
}

async function escapes(root: string, subject: string, path: string): Promise<string[]> {
  const real = await resolveReal(path);
  return within(root, real) ? [] : [`${subject} ${path}, which resolves to ${real}, outside the target directory`];
}

async function serviceViolations(name: string, entry: ComposeProject["services"][string], root: string): Promise<string[]> {
  const violations: string[] = [];
  if (entry.container_name !== undefined) violations.push(`service ${name} sets container_name ${entry.container_name}`);
  if (entry.network_mode !== undefined && !entry.network_mode.startsWith("service:")) violations.push(`service ${name} sets network_mode ${entry.network_mode}`);
  if (entry.privileged === true) violations.push(`service ${name} sets privileged`);
  for (const namespace of namespaces) {
    const mode = entry[namespace];
    if (mode === "host" || mode?.startsWith("container:")) violations.push(`service ${name} sets ${namespace} ${mode}`);
  }
  for (const hook of hooks) {
    if (entry[hook]?.some((command) => command.privileged === true)) violations.push(`service ${name} runs a privileged ${hook} hook`);
  }
  for (const device of entry.devices ?? []) violations.push(`service ${name} maps device ${device.source}`);
  for (const rule of entry.device_cgroup_rules ?? []) violations.push(`service ${name} sets device_cgroup_rules ${rule}`);
  if ((entry.gpus ?? []).length > 0) violations.push(`service ${name} requests GPUs`);
  if ((entry.deploy?.resources?.reservations?.devices ?? []).length > 0) violations.push(`service ${name} reserves devices`);
  for (const capability of entry.cap_add ?? []) violations.push(`service ${name} adds capability ${capability}`);
  for (const option of entry.security_opt ?? []) {
    if (option.includes("unconfined")) violations.push(`service ${name} sets security_opt ${option}`);
  }
  if (entry.use_api_socket === true) violations.push(`service ${name} sets use_api_socket`);
  for (const source of entry.volumes_from ?? []) {
    if (source.startsWith("container:")) violations.push(`service ${name} takes volumes from ${source}`);
  }
  for (const volume of entry.volumes ?? []) {
    if (volume.type === "bind" && volume.source !== undefined) violations.push(...(await escapes(root, `service ${name} mounts`, volume.source)));
  }
  const build = entry.build;
  if (build !== undefined) {
    const local = isAbsolute(build.context);
    if (local) violations.push(...(await escapes(root, `service ${name} builds from context`, build.context)));
    if (build.dockerfile !== undefined && (local || isAbsolute(build.dockerfile))) {
      violations.push(...(await escapes(root, `service ${name} builds from Dockerfile`, resolve(build.context, build.dockerfile))));
    }
    for (const [key, value] of Object.entries(build.additional_contexts ?? {})) {
      if (isAbsolute(value)) violations.push(...(await escapes(root, `service ${name} builds with additional context ${key}`, value)));
      else if (value.startsWith("oci-layout://")) violations.push(`service ${name} builds with additional context ${key} from host OCI layout ${value}`);
    }
    if (build.network !== undefined && !buildNetworks.includes(build.network)) violations.push(`service ${name} builds on network ${build.network}`);
    if (build.privileged === true) violations.push(`service ${name} builds privileged`);
    for (const entitlement of build.entitlements ?? []) violations.push(`service ${name} builds with entitlement ${entitlement}`);
    for (const agent of build.ssh ?? []) violations.push(`service ${name} builds with SSH ${agent}`);
    for (const cache of [...(build.cache_from ?? []), ...(build.cache_to ?? [])]) {
      if (cache.split(",").includes("type=local")) violations.push(`service ${name} builds with host cache ${cache}`);
    }
  }
  return violations;
}

async function resourceViolations(project: ComposeProject, projectName: string, root: string): Promise<string[]> {
  const violations: string[] = [];
  for (const [kind, entries] of [
    ["volume", project.volumes ?? {}],
    ["network", project.networks ?? {}],
  ] as const) {
    for (const [key, entry] of Object.entries(entries)) {
      if (entry.external === true) violations.push(`${kind} ${key} is external (${entry.name})`);
      else if (entry.name !== `${projectName}_${key}`) violations.push(`${kind} ${key} sets name ${entry.name}`);
    }
  }
  for (const [key, volume] of Object.entries(project.volumes ?? {})) {
    if (volume.driver !== undefined && volume.driver !== "local") violations.push(`volume ${key} uses driver ${volume.driver}`);
    if (volume.driver_opts !== undefined) violations.push(`volume ${key} sets driver_opts`);
  }
  for (const [kind, entries] of [
    ["secret", project.secrets ?? {}],
    ["config", project.configs ?? {}],
  ] as const) {
    for (const [key, entry] of Object.entries(entries)) {
      if (entry.file !== undefined) violations.push(...(await escapes(root, `${kind} ${key} reads file`, entry.file)));
    }
  }
  return violations;
}

export async function devContainerViolations(projectName: string, files: string[], service: string, workspace: string, env: Record<string, string | undefined>): Promise<string[]> {
  const render = ["docker", "compose", "-p", projectName, ...files.flatMap((file) => ["-f", file]), "--profile", "*", "config", "--format", "json"];
  const project = composeSchema.parse(JSON.parse(await execute(render, { env })));
  const entry = project.services[service];
  if (entry === undefined) throw new Error(`The Compose files of ${projectName} have no service ${service}`);
  const root = await realpath(workspace);
  return [...(await serviceViolations(service, entry, root)), ...(await resourceViolations(project, projectName, root))];
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
    if (!within(root, await resolveReal(resolve(sourceDir, ".devcontainer", entry)))) {
      throw new Error(`${file} names the Compose file ${entry}, which resolves outside the target directory`);
    }
  }
  const files = composeFiles.flatMap((entry) => ["-f", resolve(sourceDir, ".devcontainer", entry)]);
  const checkProject = `qa-check-${crypto.randomUUID().slice(0, 8)}`;
  const render = ["docker", "compose", "-p", checkProject, ...files, "--profile", "*", "config", "--format", "json"];
  const project = composeSchema.parse(JSON.parse(await execute(render)));
  const envFiles = envFilesSchema.parse(JSON.parse(await execute([...render, "--no-interpolate"])));
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
    violations.push(...(await serviceViolations(name, entry, root)));
    for (const envFile of envFiles.services[name]?.env_file ?? []) {
      if (envFile.path.includes("$")) violations.push(`service ${name} reads env_file ${envFile.path}, whose path uses a variable`);
      else violations.push(...(await escapes(root, `service ${name} reads env_file`, envFile.path)));
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
  violations.push(...(await resourceViolations(project, checkProject, root)));
  if (violations.length > 0) {
    throw new Error(`The Compose files of ${file} cannot run as isolated copies:\n${violations.map((line) => `- ${line}`).join("\n")}`);
  }
  return { ...ref, settings: parsed.data.customizations["qa-interns"], config, composeFiles, service, services };
}
