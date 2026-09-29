import type { Subprocess } from "bun";
import { existsSync, lstatSync } from "node:fs";
import { appendFile, mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { isIP } from "node:net";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { z } from "zod";
import { errorCode } from "./findings.ts";
import { keepHostSecrets, redact } from "./secrets.ts";

export type QaSettings = { urls: Record<string, string>; ready: string; seed: string; focus: string[]; offLimits: string[]; knownGaps: string[]; hostEnv: string[]; secrets: { hostEnv: string[]; seed: string[] }; egress: string[] };
export type TargetRef = { repo: string; path: string; commit: string; dirty: boolean };
export type ComposeService = {
  build: boolean;
  image: string | null;
  tags: string[];
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
const groups = new Set<Subprocess>();

export function killCommands(): void {
  for (const proc of running) proc.kill();
  for (const proc of groups) process.kill(-proc.pid, "SIGTERM");
}

export function track<T extends Subprocess>(proc: T): T {
  running.add(proc);
  proc.exited.then(() => running.delete(proc));
  return proc;
}

export function trackGroup<T extends Subprocess>(proc: T): T {
  groups.add(proc);
  proc.exited.then(() => groups.delete(proc));
  return proc;
}

export async function capture(cmd: string[], options: CommandOptions = {}): Promise<{ code: number; stdout: string; stderr: string }> {
  const argv = options.timeout === undefined ? cmd : ["timeout", "--kill-after=10s", `${options.timeout / 1000}s`, ...cmd];
  const started = performance.now();
  const proc = track(Bun.spawn(argv, { env: options.env, stdin: "ignore", stdout: "pipe", stderr: "pipe" }));
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  if (options.log !== undefined) await appendFile(options.log, stderr);
  if (options.timeout !== undefined && (code === 124 || code === 137) && performance.now() - started >= options.timeout) {
    throw new CommandTimeout(cmd, options.timeout / 1000, stdout, stderr);
  }
  return { code, stdout, stderr };
}

export class CommandTimeout extends Error {
  cmd: string[];
  seconds: number;
  stdout: string;
  stderr: string;

  constructor(cmd: string[], seconds: number, stdout: string, stderr: string) {
    super(`${cmd.join(" ")} timed out after ${seconds} seconds: ${redact(stderr).trim().slice(-2000)}`);
    this.name = "CommandTimeout";
    this.cmd = cmd;
    this.seconds = seconds;
    this.stdout = stdout;
    this.stderr = stderr;
  }
}

export function failure(cmd: string[], code: number, stderr: string): Error {
  return new Error(`${cmd.join(" ")} exited with ${code}: ${redact(stderr).trim().slice(-2000)}`);
}

export async function execute(cmd: string[], options: CommandOptions = {}): Promise<string> {
  const result = await capture(cmd, options);
  if (result.code !== 0) throw failure(cmd, result.code, result.stderr);
  return result.stdout;
}

const dockerEnv = ["PATH", "HOME", "DOCKER_HOST", "DOCKER_CONTEXT", "DOCKER_CERT_PATH", "DOCKER_TLS", "DOCKER_TLS_VERIFY", "DOCKER_API_VERSION"];

async function withoutProxies(file: string): Promise<string> {
  const text = existsSync(file) ? await readFile(file, "utf8") : "";
  if (text.trim() === "") return "{}";
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`${file} is not valid JSON (${String(error)})`);
  }
  const config = z.record(z.string(), z.unknown()).nullable().safeParse(parsed);
  if (!config.success) throw new Error(`${file} is not a JSON object`);
  return JSON.stringify(Object.fromEntries(Object.entries(config.data ?? {}).filter(([key]) => key.toUpperCase() !== "PROXIES")));
}

export async function dockerConfig(dir: string): Promise<string> {
  const source = resolve(process.env.DOCKER_CONFIG || join(homedir(), ".docker"));
  const config = join(dir, "docker");
  await mkdir(config, { recursive: true, mode: 0o700 });
  for (const entry of existsSync(source) ? await readdir(source) : []) {
    if (entry.toLowerCase() !== "config.json") await symlink(join(source, entry), join(config, entry));
  }
  await writeFile(join(config, "config.json"), await withoutProxies(join(source, "config.json")), { mode: 0o600 });
  return config;
}

export async function targetEnv(hostEnv: string[], dir: string): Promise<Record<string, string | undefined>> {
  const missing = hostEnv.filter((name) => process.env[name] === undefined);
  if (missing.length > 0) throw new Error(`customizations["qa-interns"].hostEnv names ${missing.join(", ")}, which the environment of qa-interns does not set`);
  return { ...Object.fromEntries([...dockerEnv, ...hostEnv].map((name) => [name, process.env[name]])), DOCKER_CONFIG: await dockerConfig(dir) };
}

async function withTargetEnv<T>(hostEnv: string[], work: (env: Record<string, string | undefined>) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "qa-interns-check-"));
  try {
    return await work(await targetEnv(hostEnv, dir));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export function isHttpUrl(value: string): boolean {
  return URL.canParse(value) && ["http:", "https:"].includes(new URL(value).protocol);
}

const hostCharacters = new Set("abcdefghijklmnopqrstuvwxyz0123456789-.");

function isHostName(value: string): boolean {
  const labels = value.split(".");
  return (
    value.length <= 253 &&
    labels.length > 1 &&
    labels.every((label) => label.length > 0 && label.length <= 63 && !label.startsWith("-") && !label.endsWith("-")) &&
    [...value].every((character) => hostCharacters.has(character)) &&
    isIP(value) === 0 &&
    URL.canParse(`https://${value}`) &&
    new URL(`https://${value}`).hostname === value
  );
}

const settingsSchema = z
  .strictObject({
    urls: z
      .record(z.string(), z.string().refine(isHttpUrl, "must be an http: or https: URL"))
      .refine((urls) => Object.keys(urls).length > 0, "must name at least one URL"),
    ready: z.string().min(1),
    seed: z.string().min(1),
    focus: z.array(z.string().min(1)).default([]),
    offLimits: z.array(z.string().min(1)).default([]),
    knownGaps: z.array(z.string().min(1)).default([]),
    hostEnv: z.array(z.string().min(1)).default([]),
    secrets: z
      .strictObject({ hostEnv: z.array(z.string().min(1)).default([]), seed: z.array(z.string().min(1)).default([]) })
      .default({ hostEnv: [], seed: [] }),
    egress: z.array(z.string().refine(isHostName, "must be a lowercase host name with at least two labels, not an IP address or a wildcard")).default([]),
  })
  .refine((settings) => settings.secrets.hostEnv.every((name) => settings.hostEnv.includes(name)), {
    error: "must name only variables that hostEnv names",
    path: ["secrets", "hostEnv"],
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
  tags: z.array(z.string()).optional(),
});

const composeSchema = z.object({
  services: z.record(
    z.string(),
    z.object({
      build: buildSchema.optional(),
      image: z.string().optional(),
      container_name: z.string().optional(),
      network_mode: z.string().optional(),
      networks: z.record(z.string(), z.object({ aliases: z.array(z.string()).optional() }).nullable()).optional(),
      mem_limit: z.string().optional(),
      cpus: z.number().optional(),
      pids_limit: z.number().optional(),
      scale: z.number().optional(),
      deploy: z
        .object({
          replicas: z.number().optional(),
          resources: z.object({ limits: limitsSchema.optional(), reservations: z.object({ devices: z.array(z.unknown()).optional() }).optional() }).optional(),
        })
        .optional(),
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
      runtime: z.string().optional(),
      env_file: z.array(z.object({ path: z.string() })).optional(),
      volumes: z.array(z.object({ type: z.string(), source: z.string().optional(), target: z.string().optional() })).optional(),
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

const renderSchema = z
  .object({ services: z.record(z.string(), z.record(z.string(), z.unknown())), volumes: z.record(z.string(), z.unknown()).optional() })
  .catchall(z.unknown());

type ComposeProject = z.infer<typeof composeSchema>;

const referencesSchema = z
  .object({
    include: z
      .array(
        z.union([
          z.string(),
          z.object({
            path: z.union([z.string(), z.tuple([z.string()], z.string())]),
            project_directory: z.string().optional(),
            env_file: z.union([z.string(), z.array(z.string())]).optional(),
          }),
        ]),
      )
      .nullish(),
    services: z
      .record(z.string(), z.union([z.object({ extends: z.union([z.string(), z.object({ file: z.string().optional() })]).optional() }), z.string()]).nullable())
      .nullish(),
  })
  .nullable();

const reservedServices = ["qa-proxy", "qa-relay", "qa-runner"];
const namespaces = ["pid", "ipc", "uts", "cgroup", "userns_mode"] as const;
const hooks = ["pre_start", "post_start", "pre_stop"] as const;
const buildNetworks = ["default", "none"];
const confinedOptions = ["no-new-privileges", "no-new-privileges:true", "no-new-privileges=true"];
const devContainerKeys = ["image", "build", "entrypoint", "command", "init", "user", "environment", "labels", "privileged", "cap_add", "security_opt", "volumes"];

export async function composeVersion(): Promise<string> {
  const version = (await execute(["docker", "compose", "version", "--short"])).trim();
  if (Number(version.split(".")[0]) < 5) {
    throw new Error(`QA Interns needs Docker Compose 5.0 or later, which reports env_file paths in docker compose config --no-env-resolution; this host has Compose ${version}`);
  }
  return version;
}

async function render(projectName: string, files: string[], env?: Record<string, string | undefined>): Promise<unknown> {
  const cmd = ["docker", "compose", "-p", projectName, ...files.flatMap((file) => ["-f", file]), "--profile", "*", "config", "--format", "json", "--no-env-resolution"];
  return JSON.parse(await execute(cmd, { env }));
}

export async function resolveTarget(dir: string, rev: string, dirty: boolean): Promise<TargetRef> {
  const git = ["git", "-C", dir, "rev-parse"];
  const repo = (await execute([...git, "--show-toplevel"])).trim();
  const prefix = (await execute([...git, "--show-prefix"])).trim();
  const commit = (await execute([...git, "--verify", "--end-of-options", `${rev}^{commit}`])).trim();
  return { repo, path: prefix.endsWith("/") ? prefix.slice(0, -1) : prefix, commit, dirty };
}

function present(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if (errorCode(error) === "ENOENT" || errorCode(error) === "ENOTDIR") return false;
    throw error;
  }
}

async function workingTreeFiles(dir: string): Promise<Buffer> {
  const listed = await execute(["git", "-C", dir, "ls-files", "-z", "--cached", "--others", "--exclude-standard", "--deduplicate"]);
  const files = listed.split("\0").filter((file) => file !== "" && present(join(dir, file)));
  return Buffer.from(files.map((file) => `${file}\0`).join(""));
}

export async function exportTree(ref: TargetRef, dest: string): Promise<void> {
  await mkdir(dest, { recursive: true });
  const dir = join(ref.repo, ref.path);
  const archiveCmd = ref.dirty
    ? ["tar", "-c", "-C", dir, "--no-recursion", "--null", "--verbatim-files-from", "-T", "-"]
    : ["git", "-C", ref.repo, "archive", "--format=tar", `${ref.commit}:${ref.path}`];
  const extractCmd = ["tar", "-x", "-C", dest];
  const archive = track(Bun.spawn(archiveCmd, { stdin: ref.dirty ? await workingTreeFiles(dir) : "ignore", stdout: "pipe", stderr: "pipe" }));
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

async function resolveReal(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
    return join(await resolveReal(dirname(path)), basename(path));
  }
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
  if (entry.runtime !== undefined && entry.runtime !== "runc") violations.push(`service ${name} sets runtime ${entry.runtime}`);
  for (const capability of entry.cap_add ?? []) violations.push(`service ${name} adds capability ${capability}`);
  for (const option of entry.security_opt ?? []) {
    if (!confinedOptions.includes(option)) violations.push(`service ${name} sets security_opt ${option}`);
  }
  if (entry.use_api_socket === true) violations.push(`service ${name} sets use_api_socket`);
  for (const source of entry.volumes_from ?? []) {
    if (source.startsWith("container:")) violations.push(`service ${name} takes volumes from ${source}`);
  }
  for (const volume of entry.volumes ?? []) {
    if (volume.type === "bind" && volume.source !== undefined) violations.push(...(await escapes(root, `service ${name} mounts`, volume.source)));
  }
  for (const envFile of entry.env_file ?? []) violations.push(...(await escapes(root, `service ${name} reads env_file`, envFile.path)));
  return violations;
}

async function buildViolations(name: string, build: z.infer<typeof buildSchema>, root: string): Promise<string[]> {
  const violations: string[] = [];
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
  for (const cache of build.cache_from ?? []) {
    if (cache.includes("=")) violations.push(`service ${name} builds with cache_from ${cache}`);
  }
  for (const cache of build.cache_to ?? []) violations.push(`service ${name} builds with cache_to ${cache}`);
  return violations;
}

async function projectEnvViolations(root: string, files: string[]): Promise<string[]> {
  const [first] = files;
  if (first === undefined) throw new Error("A Compose project needs at least one Compose file");
  return escapes(root, "Compose reads the project .env file", join(dirname(first), ".env"));
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

export async function devContainerViolations(
  projectName: string,
  baseFiles: string[],
  files: string[],
  service: string,
  workspace: string,
  env: Record<string, string | undefined>,
): Promise<string[]> {
  const before = renderSchema.parse(await render(projectName, baseFiles, env));
  const rendered = await render(projectName, files, env);
  const after = renderSchema.parse(rendered);
  const project = composeSchema.parse(rendered);
  const violations: string[] = [];
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (key !== "services" && key !== "volumes" && !Bun.deepEquals(before[key], after[key])) violations.push(`devcontainer up changes the top-level ${key}`);
  }
  for (const [name, volume] of Object.entries(before.volumes ?? {})) {
    if (!Bun.deepEquals(volume, after.volumes?.[name])) violations.push(`devcontainer up changes volume ${name}`);
  }
  for (const name of new Set([...Object.keys(before.services), ...Object.keys(after.services)])) {
    const was = before.services[name] ?? {};
    const is = after.services[name] ?? {};
    if (name !== service) {
      if (!Bun.deepEquals(was, is)) violations.push(`devcontainer up changes service ${name}`);
      continue;
    }
    for (const key of new Set([...Object.keys(was), ...Object.keys(is)])) {
      if (!devContainerKeys.includes(key) && !Bun.deepEquals(was[key], is[key])) violations.push(`devcontainer up changes ${key} of service ${name}`);
    }
  }
  const root = await realpath(workspace);
  violations.push(...(await projectEnvViolations(root, baseFiles)));
  for (const [name, entry] of Object.entries(project.services)) {
    if (!reservedServices.includes(name)) violations.push(...(await serviceViolations(name, entry, root)));
  }
  return [...violations, ...(await resourceViolations(project, projectName, root))];
}

async function checkComposeReferences(root: string, composePaths: string[]): Promise<void> {
  const seen = new Set<string>();
  const walk = async (file: string, dir: string, kind: "top" | "included" | "extended"): Promise<void> => {
    const key = JSON.stringify([file, dir, kind]);
    if (seen.has(key)) return;
    seen.add(key);
    const inside = async (field: string, value: string, base: string | null): Promise<string> => {
      if (value.includes("$") || value.includes(":") || value.startsWith("~") || value.startsWith("github.com/")) {
        throw new Error(`${file} names ${value} in ${field}, which Compose may expand or load from a remote source`);
      }
      if (base === null && !isAbsolute(value)) throw new Error(`${file} names ${value} in ${field}, a relative path that Compose resolves against the directory it runs in`);
      const path = resolve(base ?? "/", value);
      if (!existsSync(path) || !within(root, await realpath(path))) {
        throw new Error(`${file} names ${value} in ${field}, which does not resolve to an existing path inside the target directory`);
      }
      return path;
    };
    const text = await Bun.file(file).text();
    let parsed: unknown;
    try {
      parsed = Bun.YAML.parse(text);
    } catch (error) {
      throw new Error(`${file} is not valid YAML: ${error}`);
    }
    for (const document of Array.isArray(parsed) ? parsed : [parsed]) {
      const references = referencesSchema.safeParse(document);
      if (!references.success) throw new Error(`${file} is invalid:\n${z.prettifyError(references.error)}`);
      const { include, services } = references.data ?? {};
      for (const entry of kind !== "extended" ? (include ?? []) : []) {
        const { path, project_directory, env_file } = typeof entry === "string" ? { path: entry } : entry;
        const [main, ...overrides] = typeof path === "string" ? ([path] as const) : path;
        const workingDir = kind === "top" ? dir : null;
        const projectDir = project_directory ? await inside("include.project_directory", project_directory, workingDir) : dirname(resolve(dir, main));
        const envFiles = [env_file ?? []].flat();
        const dotenv = join(projectDir, ".env");
        if (envFiles.length === 0 && existsSync(dotenv) && !within(root, await realpath(dotenv))) {
          throw new Error(`${file} includes ${main}, whose project directory has a .env file that resolves outside the target directory`);
        }
        for (const value of envFiles.filter((value) => value !== "/dev/null")) await inside("include.env_file", value, workingDir);
        for (const value of [main, ...overrides]) await walk(await inside("include", value, dir), projectDir, "included");
      }
      for (const [name, service] of Object.entries(services ?? {})) {
        const base = typeof service === "string" ? undefined : service?.extends;
        if (typeof base !== "object" || base.file === undefined) continue;
        const extended = await inside(`services.${name}.extends.file`, base.file, dir);
        await walk(extended, dirname(extended), "extended");
      }
    }
  };
  let projectDir: string | undefined;
  for (const file of composePaths) {
    projectDir ??= dirname(file);
    await walk(file, projectDir, "top");
  }
}

function checkedSettings({ project, started }: { project: ComposeProject; started: ComposeProject["services"] }): Record<string, unknown> {
  const named = (kind: string, entries: Record<string, unknown> = {}) => Object.entries(entries).map(([name, value]) => [`${kind} ${name}`, value]);
  return Object.fromEntries([
    ...Object.entries(project.services).flatMap(([name, entry]) => Object.entries(entry).map(([key, value]) => [`${key} of service ${name}`, value])),
    ...named("volume", project.volumes),
    ...named("network", project.networks),
    ...named("secret", project.secrets),
    ...named("config", project.configs),
    ["the services that run starts", Object.keys(started)],
  ]);
}

export async function loadTarget(ref: TargetRef, sourceDir: string, placeholders = false): Promise<Target> {
  const file = join(sourceDir, ".devcontainer", "devcontainer.json");
  const object = z.record(z.string(), z.unknown()).safeParse(Bun.JSONC.parse(await Bun.file(file).text()));
  if (!object.success) throw new Error(`${file} is not a JSON object`);
  const config = object.data;
  if (Array.isArray(config.runServices) && config.runServices.length === 0) delete config.runServices;
  if (config.dockerComposeFile === undefined) {
    throw new Error(`${file} has no dockerComposeFile. Single-container dev containers are not supported yet; use a Docker Compose dev container.`);
  }
  const parsed = configSchema.safeParse(config);
  if (!parsed.success) throw new Error(`${file} is invalid:\n${z.prettifyError(parsed.error)}`);
  const { dockerComposeFile, service, runServices, customizations } = parsed.data;
  const composeFiles = typeof dockerComposeFile === "string" ? [dockerComposeFile] : dockerComposeFile;
  const root = await realpath(sourceDir);
  const paths = composeFiles.map((entry) => resolve(sourceDir, ".devcontainer", entry));
  for (const [index, path] of paths.entries()) {
    if (!within(root, await resolveReal(path))) {
      throw new Error(`${file} names the Compose file ${composeFiles[index]}, which resolves outside the target directory`);
    }
  }
  await checkComposeReferences(root, paths);
  await composeVersion();
  const checkProject = `qa-check-${crypto.randomUUID().slice(0, 8)}`;
  const hostEnv = customizations["qa-interns"].hostEnv;
  const unset = placeholders ? hostEnv.filter((name) => process.env[name] === undefined) : [];
  const unkept = keepHostSecrets(customizations["qa-interns"].secrets.hostEnv.filter((name) => !unset.includes(name)));
  if (unkept !== null) throw new Error(unkept);
  const files = paths.flatMap((path) => ["-f", path]);
  const renderWith = (placeholder: (name: string) => string) =>
    withTargetEnv(
      hostEnv.filter((name) => !unset.includes(name)),
      async (hostValues) => {
        const env = { ...hostValues, ...Object.fromEntries(unset.map((name) => [name, placeholder(name)])) };
        const project = composeSchema.parse(await render(checkProject, paths, env));
        if (!Object.hasOwn(project.services, service)) throw new Error(`${file} names service ${service}, which is not in its Compose files`);
        const selection = await execute(
          ["docker", "compose", "-p", checkProject, ...files, "config", "--format", "json", "--no-env-resolution", ...(runServices === undefined ? [] : [service, ...runServices])],
          { env },
        );
        return { project, started: composeSchema.parse(JSON.parse(selection)).services };
      },
    );
  const rendered = await renderWith((name) => `/qa-interns-unset/${name}`);
  const { project, started } = rendered;
  if (unset.length > 0) {
    const [one, two] = [checkedSettings(rendered), checkedSettings(await renderWith((name) => `/qa-interns-unset/${name}/${name}`))];
    const dependent = [...new Set([...Object.keys(one), ...Object.keys(two)])].filter((setting) => !Bun.deepEquals(one[setting], two[setting]));
    if (dependent.length > 0) {
      throw new Error(
        `customizations["qa-interns"].hostEnv names ${unset.join(", ")}, which the environment of qa-interns does not set, and these checked settings depend on one or more of them:\n${dependent.map((setting) => `- ${setting}`).join("\n")}`,
      );
    }
  }
  const violations = await projectEnvViolations(root, paths);
  const services: Record<string, ComposeService> = {};
  const tags = new Map<string, string>();
  const aliasOwners = new Map<string, string>();
  for (const [name, entry] of Object.entries(project.services)) {
    if (reservedServices.includes(name.toLowerCase())) violations.push(`service ${name} uses a name QA Interns reserves`);
    violations.push(...(await serviceViolations(name, entry, root)));
    if (entry.build !== undefined) violations.push(...(await buildViolations(name, entry.build, root)));
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
    const active = Object.hasOwn(started, name);
    const limits = entry.deploy?.resources?.limits;
    const memory = entry.mem_limit ?? limits?.memory;
    services[name] = {
      build: entry.build !== undefined,
      image: entry.image ?? null,
      tags: entry.build?.tags ?? [],
      memLimit: memory === undefined ? null : bytes(memory, `The memory limit of service ${name}`),
      networkMode: entry.network_mode ?? null,
      aliases,
      hasCpus: (entry.cpus ?? 0) > 0 || (limits?.cpus ?? 0) > 0,
      hasPidsLimit: (entry.pids_limit ?? 0) > 0 || (limits?.pids ?? 0) > 0,
      deployLimits: limits !== undefined,
      replicas: entry.scale ?? entry.deploy?.replicas ?? 1,
      active,
    };
  }
  for (const host of parsed.data.customizations["qa-interns"].egress) {
    if (tags.has(host) || aliasOwners.has(host)) violations.push(`egress host ${host} is the name or a network alias of a service`);
  }
  violations.push(...(await resourceViolations(project, checkProject, root)));
  if (violations.length > 0) {
    throw new Error(`The Compose files of ${file} cannot run as isolated copies:\n${violations.map((line) => `- ${line}`).join("\n")}`);
  }
  return { ...ref, settings: customizations["qa-interns"], config, composeFiles, service, services };
}
