import { existsSync } from "node:fs";
import { lstat, mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { errorCode } from "./findings.ts";
import { capture, execute, failure, isHttpUrl, targetEnv, type Target } from "./target.ts";
import type { GeneratedFile, Mount } from "./types.ts";

export type RunnerSpec = { image: string; out: string; env: Record<string, string>; mounts: Mount[]; files: GeneratedFile[]; tmpfs: string[] };
export type EnvironmentSpec = {
  runId: string;
  runDir: string;
  name: string;
  slot: number;
  target: Target | null;
  images: Record<string, string>;
  runner: RunnerSpec;
  egress: string[];
};
export type Environment = { project: string; runner: string; out: string; devContainer: string | null; seed: unknown };

const devcontainer = join(dirname(fileURLToPath(import.meta.resolve("@devcontainers/cli/package.json"))), "devcontainer.js");
const gib = 1024 ** 3;
const mib = 1024 ** 2;
const minute = 60_000;
const readyTimeout = 5 * minute;
const waitTimeoutSeconds = "600";
const proxyUrl = "http://qa-proxy:3128";
const outLimit = gib;
const outCheckMs = 1000;

type Cidr = { address: number; bits: number };

function parseCidr(value: string): Cidr {
  const [address = "", prefix = "32"] = value.split("/");
  const octets = address.split(".");
  const bits = Number(prefix);
  const valid =
    octets.length === 4 &&
    octets.every((octet) => octet !== "" && Number.isInteger(Number(octet)) && Number(octet) >= 0 && Number(octet) <= 255) &&
    Number.isInteger(bits) &&
    bits >= 0 &&
    bits <= 32;
  if (!valid) throw new Error(`${value} is not an IPv4 address or CIDR block`);
  return { address: octets.reduce((sum, octet) => sum * 256 + Number(octet), 0), bits };
}

function overlaps(a: Cidr, b: Cidr): boolean {
  const size = 2 ** (32 - Math.min(a.bits, b.bits));
  return Math.floor(a.address / size) === Math.floor(b.address / size);
}

const networksSchema = z.array(z.object({ IPAM: z.object({ Config: z.array(z.object({ Subnet: z.string() })).nullable() }) }));
const routesSchema = z.array(z.object({ dst: z.string() }));

async function networkIds(): Promise<string[]> {
  return (await execute(["docker", "network", "ls", "-q"])).split("\n").filter((id) => id !== "");
}

async function inspectNetwork(id: string): Promise<z.infer<typeof networksSchema>> {
  const cmd = ["docker", "network", "inspect", id];
  const result = await capture(cmd);
  if (result.code === 0) return networksSchema.parse(JSON.parse(result.stdout));
  if (!(await networkIds()).includes(id)) return [];
  throw failure(cmd, result.code, result.stderr);
}

async function usedBlocks(): Promise<Cidr[]> {
  const networks = (await Promise.all((await networkIds()).map(inspectNetwork))).flat();
  const routes = routesSchema.parse(JSON.parse(await execute(["ip", "-4", "-j", "route", "show", "table", "all"])));
  const subnets = networks.flatMap((network) => (network.IPAM.Config ?? []).map((config) => config.Subnet)).filter((subnet) => !subnet.includes(":"));
  const destinations = routes.map((route) => route.dst).filter((dst) => dst !== "default");
  return [...subnets, ...destinations].map(parseCidr);
}

export function slotSubnets(slot: number): { internal: string; agent: string; egress: string } {
  if (!Number.isInteger(slot) || slot < 0 || slot > 127) throw new Error(`Slot ${slot} is not an integer from 0 to 127`);
  return { internal: `10.213.${slot * 2}.0/25`, agent: `10.213.${slot * 2}.128/25`, egress: `10.213.${slot * 2 + 1}.0/24` };
}

export async function freeSlot(reserved: Set<number>): Promise<number> {
  const used = await usedBlocks();
  for (let slot = 0; slot < 128; slot++) {
    if (reserved.has(slot)) continue;
    const blocks = Object.values(slotSubnets(slot)).map(parseCidr);
    if (used.some((block) => blocks.some((own) => overlaps(block, own)))) continue;
    reserved.add(slot);
    return slot;
  }
  throw new Error("No free network slot: every 10.213.x.0/23 block overlaps a Docker network, a host route, or a slot this run holds");
}

function projectName(runId: string, name: string): string {
  return `qa-${runId}-${name}`;
}

function envDir(spec: EnvironmentSpec): string {
  return join(spec.runDir, "envs", spec.name);
}

function generatedPath(spec: EnvironmentSpec, file: GeneratedFile): string {
  return join(envDir(spec), "files", file.target);
}

function bind(source: string, target: string, readOnly: boolean) {
  return { type: "bind", source, target, read_only: readOnly, bind: { create_host_path: false } };
}

export function renderOverride(spec: EnvironmentSpec, uid: number, gid: number): string {
  if (spec.egress.length === 0) throw new Error(`Environment ${spec.name} has no egress hosts for qa-proxy`);
  const { internal, agent, egress } = slotSubnets(spec.slot);
  const y = (value: unknown) => JSON.stringify(value);
  const isolated = (subnet: string) => ({ internal: true, driver_opts: { "com.docker.network.bridge.gateway_mode_ipv4": "isolated" }, ipam: { config: [{ subnet }] } });
  const lines = ["services:"];
  for (const [name, service] of Object.entries(spec.target?.services ?? {})) {
    lines.push(`  ${y(name)}:`, "    ports: !reset []");
    if (!service.networkMode?.startsWith("service:")) {
      const networks = service.aliases.length > 0 ? { qa_internal: { aliases: service.aliases } } : ["qa_internal"];
      lines.push(`    networks: !override ${y(networks)}`);
    }
    const memory = service.memLimit === null ? "1g" : null;
    const cpus = service.hasCpus ? null : 2;
    const pids = service.hasPidsLimit ? null : 1024;
    if (service.deployLimits) {
      const limits = Object.fromEntries(Object.entries({ memory, cpus, pids }).filter(([, value]) => value !== null));
      if (Object.keys(limits).length > 0) lines.push(`    deploy: ${y({ resources: { limits } })}`);
    } else {
      if (memory !== null) lines.push(`    mem_limit: ${y(memory)}`);
      if (cpus !== null) lines.push(`    cpus: ${cpus}`);
      if (pids !== null) lines.push(`    pids_limit: ${pids}`);
    }
    const image = spec.images[name];
    if (image !== undefined) lines.push(`    image: ${y(image)}`, "    build: !reset null", `    pull_policy: ${y("never")}`);
  }
  const hardening = [
    "    init: true",
    "    read_only: true",
    `    cap_drop: ${y(["ALL"])}`,
    `    security_opt: ${y(["no-new-privileges:true"])}`,
    `    logging: ${y({ driver: "local", options: { "max-size": "10m", "max-file": "2" } })}`,
  ];
  const volumes = [
    bind(spec.runner.out, "/qa/out", false),
    bind(join(spec.runDir, "chrome-policy.json"), "/etc/opt/chrome_for_testing/policies/managed/qa-interns.json", true),
    ...spec.runner.mounts.map((mount) => bind(mount.source, mount.target, mount.readOnly)),
    ...spec.runner.files.map((file) => bind(generatedPath(spec, file), file.target, false)),
  ];
  lines.push(
    `  "qa-proxy":`,
    `    image: ${y(spec.runner.image)}`,
    `    pull_policy: ${y("never")}`,
    `    command: ${y(["node", "/opt/qa-interns/proxy.mjs"])}`,
    `    environment: ${y({ QA_PROXY_ALLOW: spec.egress.join(",") })}`,
    `    networks: ${y(["qa_agent", "qa_egress"])}`,
    ...hardening,
    `    mem_limit: ${y("128m")}`,
    "    cpus: 0.5",
    "    pids_limit: 128",
    `  "qa-runner":`,
    `    image: ${y(spec.runner.image)}`,
    `    pull_policy: ${y("never")}`,
    `    tmpfs: ${y([
      "/tmp:rw,nosuid,nodev,size=1g",
      `/home/qa:rw,nosuid,nodev,size=256m,uid=${uid},gid=${gid},mode=0700`,
      ...spec.runner.tmpfs.map((path) => `${path}:rw,nosuid,nodev,size=64m,uid=${uid},gid=${gid},mode=0700`),
    ])}`,
    `    volumes: ${y(volumes)}`,
    `    environment: ${y(spec.runner.env)}`,
    ...hardening,
    "    pids_limit: 1024",
    `    ulimits: ${y({ fsize: outLimit })}`,
    `    mem_limit: ${y("2g")}`,
    "    cpus: 2",
    `    networks: ${y(["qa_internal", "qa_agent"])}`,
    "networks:",
    `  qa_internal: ${y(isolated(internal))}`,
    `  qa_agent: ${y(isolated(agent))}`,
    `  qa_egress: ${y({ ipam: { config: [{ subnet: egress }] } })}`,
  );
  return `${lines.join("\n")}\n`;
}

export function environmentMemory(target: Target | null): number {
  const services = Object.values(target?.services ?? {}).filter((service) => service.active);
  return services.reduce((sum, service) => sum + (service.memLimit ?? gib) * service.replicas, 2 * gib + 128 * mib);
}

function urlHosts(urls: Record<string, string>): string[] {
  return [...new Set(Object.values(urls).map((url) => new URL(url).hostname))];
}

export async function writeChromePolicy(runDir: string, urls: Record<string, string>): Promise<void> {
  const hosts = urlHosts(urls).filter((host) => !host.includes("."));
  await Bun.write(join(runDir, "chrome-policy.json"), `${JSON.stringify({ HSTSPolicyBypassList: hosts }, null, 2)}\n`);
}

export function runnerEnv(urls: Record<string, string>): Record<string, string> {
  const hosts = urlHosts(urls);
  const noProxy = [...hosts, "localhost", "127.0.0.1"].join(",");
  return {
    HOME: "/home/qa",
    HTTPS_PROXY: proxyUrl,
    HTTP_PROXY: proxyUrl,
    https_proxy: proxyUrl,
    http_proxy: proxyUrl,
    NO_PROXY: noProxy,
    no_proxy: noProxy,
    NODE_USE_ENV_PROXY: "1",
    AGENT_BROWSER_ALLOWED_DOMAINS: hosts.join(","),
  };
}

function sourceComposeArgs(target: Target, root: string): string[] {
  return target.composeFiles.flatMap((entry) => ["-f", resolve(root, ".devcontainer", entry)]);
}

export async function buildImages(runId: string, target: Target, sourceDir: string): Promise<Record<string, string>> {
  const services = Object.entries(target.services)
    .filter(([, service]) => service.build && service.active)
    .map(([name]) => name);
  const images = Object.fromEntries(services.map((name) => [name, `qa-${runId}-${name.toLowerCase()}:latest`]));
  if (services.length === 0) return images;
  const dir = await mkdtemp(join(tmpdir(), "qa-interns-tags-"));
  try {
    const tags = join(dir, "tags.yml");
    const lines = services.flatMap((name) => [`  ${JSON.stringify(name)}:`, `    image: ${JSON.stringify(images[name])}`, "    build:", "      tags: !reset []"]);
    await Bun.write(tags, `services:\n${lines.join("\n")}\n`);
    await execute(["docker", "compose", "-p", projectName(runId, "build"), ...sourceComposeArgs(target, sourceDir), "-f", tags, "build", ...services], {
      env: targetEnv(target.settings.hostEnv),
      timeout: 30 * minute,
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  return images;
}

function composeArgs(spec: EnvironmentSpec): string[] {
  const dir = envDir(spec);
  const target = spec.target === null ? [] : sourceComposeArgs(spec.target, join(dir, projectName(spec.runId, spec.name)));
  return [...target, "-f", join(dir, "compose.qa.yml")];
}

async function writeFiles(spec: EnvironmentSpec): Promise<void> {
  await mkdir(spec.runner.out, { recursive: true });
  for (const file of spec.runner.files) await Bun.write(generatedPath(spec, file), file.content);
  const { uid, gid } = userInfo();
  await Bun.write(join(envDir(spec), "compose.qa.yml"), renderOverride(spec, uid, gid));
}

async function runnerId(project: string): Promise<string> {
  const id = (await execute(["docker", "compose", "-p", project, "ps", "-q", "qa-runner"])).trim();
  if (id === "") throw new Error(`Compose project ${project} has no qa-runner container`);
  return id;
}

function overrideConfig(target: Target, composeFile: string): Record<string, unknown> {
  const runServices = target.config.runServices;
  return {
    ...target.config,
    dockerComposeFile: [...target.composeFiles, composeFile],
    ...(Array.isArray(runServices) ? { runServices: [...runServices, "qa-proxy", "qa-runner"] } : {}),
  };
}

const upSchema = z.object({ outcome: z.string(), containerId: z.string().optional(), message: z.string().optional(), description: z.string().optional() });

async function waitReady(ready: string, runner: string, exec: string[], env: Record<string, string | undefined>, log: string): Promise<void> {
  const url = isHttpUrl(ready);
  const probe = url
    ? ["docker", "exec", runner, "curl", "-sS", "-o", "/dev/null", "-w", "%{http_code}", "--max-time", "10", "--noproxy", "*", ready]
    : [...exec, "sh", "-c", ready];
  const deadline = Date.now() + readyTimeout;
  while (true) {
    const result = await capture(probe, { env, log, timeout: url ? undefined : Math.max(1000, deadline - Date.now()) });
    const status = Number(result.stdout.trim());
    if (result.code === 0 && (!url || (status >= 200 && status < 300))) return;
    if (Date.now() >= deadline) {
      throw new Error(`The ready check ${ready} did not pass within 5 minutes: exit ${result.code}, ${url ? `status ${result.stdout.trim()}, ` : ""}${result.stderr.trim().slice(-500)}`);
    }
    await Bun.sleep(2000);
  }
}

export async function startEnvironment(spec: EnvironmentSpec): Promise<Environment> {
  const project = projectName(spec.runId, spec.name);
  const dir = envDir(spec);
  const log = join(dir, "env.log");
  await writeFiles(spec);
  if (spec.target === null) {
    await execute(["docker", "compose", "-p", project, ...composeArgs(spec), "up", "-d", "--wait", "--wait-timeout", waitTimeoutSeconds], { log });
    return { project, runner: await runnerId(project), out: spec.runner.out, devContainer: null, seed: null };
  }
  const target = spec.target;
  const env = targetEnv(target.settings.hostEnv);
  const workspace = join(dir, project);
  const config = join(dir, "devcontainer.json");
  const tmp = join(dir, "tmp");
  await execute(["cp", "-a", "--reflink=auto", join(spec.runDir, "source"), workspace]);
  await mkdir(tmp, { recursive: true });
  await Bun.write(config, `${JSON.stringify(overrideConfig(target, join(dir, "compose.qa.yml")), null, 2)}\n`);

  const up = await capture(
    [process.execPath, devcontainer, "up", "--workspace-folder", workspace, "--override-config", config, "--user-data-folder", join(dir, "devcontainer-data"), "--id-label", `qa-interns.env=${project}`, "--log-format", "json"],
    { env: { ...env, COMPOSE_PROJECT_NAME: project, TMPDIR: tmp }, log, timeout: 20 * minute },
  );
  const last = up.stdout.trim().split("\n").at(-1) ?? "";
  const result = upSchema.safeParse(last.startsWith("{") ? JSON.parse(last) : null);
  if (up.code !== 0 || !result.success || result.data.outcome !== "success" || result.data.containerId === undefined) {
    const detail = result.success ? [result.data.message, result.data.description].filter((part) => part !== undefined).join(" ") : up.stderr.trim().slice(-2000);
    throw new Error(`devcontainer up for ${project} exited with ${up.code}: ${detail} (log: ${log})`);
  }
  const devContainer = result.data.containerId;

  const runServices = target.config.runServices;
  const services = Array.isArray(runServices) ? [target.service, ...runServices, "qa-proxy", "qa-runner"] : [];
  await execute(
    ["docker", "compose", "-p", project, ...composeArgs(spec), "up", "-d", "--wait", "--wait-timeout", waitTimeoutSeconds, "--no-recreate", ...services],
    { env, log },
  );
  const runner = await runnerId(project);
  const exec = [process.execPath, devcontainer, "exec", "--container-id", devContainer, "--workspace-folder", workspace, "--override-config", config];
  await waitReady(target.settings.ready, runner, exec, env, log);
  const output = await execute([...exec, "sh", "-c", target.settings.seed], { env, log, timeout: 10 * minute });
  let seed: unknown;
  try {
    seed = JSON.parse(output);
  } catch (error) {
    throw new Error(`The seed command ${target.settings.seed} did not print one JSON document (${String(error)}); it printed: ${output.slice(0, 500)}`);
  }
  return { project, runner, out: spec.runner.out, devContainer, seed };
}

function vanished<T>(value: T): (error: unknown) => T {
  return (error) => {
    const code = errorCode(error);
    if (code === "ENOENT" || code === "ENOTDIR") return value;
    throw error;
  };
}

async function overLimit(dir: string): Promise<boolean> {
  const seen = new Set<string>();
  let total = (await lstat(dir)).blocks * 512;
  const dirs = [dir];
  for (let next = dirs.pop(); next !== undefined; next = dirs.pop()) {
    for (const name of await readdir(next).catch(vanished([]))) {
      const path = join(next, name);
      const stats = await lstat(path).catch(vanished(null));
      if (stats === null) continue;
      const inode = `${stats.dev}:${stats.ino}`;
      if (seen.has(inode)) continue;
      seen.add(inode);
      total += stats.blocks * 512;
      if (total > outLimit) return true;
      if (stats.isDirectory()) dirs.push(path);
    }
  }
  return false;
}

export async function watchOut(dir: string, signal: AbortSignal): Promise<string> {
  for (;;) {
    await Bun.sleep(outCheckMs);
    signal.throwIfAborted();
    if (await overLimit(dir)) return `${dir} holds more than ${outLimit / gib} GiB`;
  }
}

async function down(project: string): Promise<void> {
  await execute(["docker", "compose", "-p", project, "down", "-v", "--remove-orphans", "--rmi", "local", "--timeout", "2"]);
  const label = `label=com.docker.compose.project=${project}`;
  const left = await Promise.all([
    execute(["docker", "ps", "-aq", "--filter", label]),
    execute(["docker", "network", "ls", "-q", "--filter", label]),
    execute(["docker", "volume", "ls", "-q", "--filter", label]),
  ]);
  const ids = left.join("\n").split("\n").filter((id) => id !== "");
  if (ids.length > 0) throw new Error(`docker compose down left objects of ${project} behind: ${ids.join(", ")}`);
}

async function removeImages(prefixes: string[]): Promise<void> {
  const listed = (await execute(["docker", "image", "ls", "--format", "{{.Repository}}:{{.Tag}}"])).split("\n");
  const images = listed.filter((image) => prefixes.some((prefix) => image.startsWith(prefix)));
  if (images.length > 0) await execute(["docker", "image", "rm", ...images]);
}

async function removeAsRoot(dir: string, image: string, paths: string[]): Promise<void> {
  await execute(["docker", "run", "--rm", "--network", "none", "--user", "0:0", "-v", `${dir}:/env`, image, "rm", "-rf", ...paths.map((path) => `/env/${path}`)]);
}

export async function stopEnvironment(runDir: string, name: string, project: string, image: string): Promise<void> {
  await down(project);
  await removeImages([`vsc-${project}-`]);
  await removeAsRoot(join(runDir, "envs", name), image, [project, "tmp"]);
}

export async function removeCopies(runDir: string, runId: string, image: string): Promise<void> {
  const envs = join(runDir, "envs");
  const names = existsSync(envs) ? await readdir(envs) : [];
  const paths = names.flatMap((name) => [join(name, projectName(runId, name)), join(name, "tmp")]).filter((path) => existsSync(join(envs, path)));
  if (paths.length === 0) return;
  if ((await capture(["docker", "image", "inspect", image])).code !== 0) {
    throw new Error(`${envs} still holds ${paths.join(", ")}, which only a container of the runner image can remove, and the runner image ${image} does not exist. Build it with qa-interns doctor, then run qa-interns down again.`);
  }
  await removeAsRoot(envs, image, paths);
}

export async function stopRun(runId: string): Promise<void> {
  const prefix = `qa-${runId}-`;
  const listing = ["--filter", "label=com.docker.compose.project", "--format", '{{.Label "com.docker.compose.project"}}'];
  const found = await Promise.all([
    execute(["docker", "ps", "-a", ...listing]),
    execute(["docker", "network", "ls", ...listing]),
    execute(["docker", "volume", "ls", ...listing]),
  ]);
  const projects = [...new Set(found.join("\n").split("\n"))].filter((project) => project.startsWith(prefix));
  const results = await Promise.allSettled(projects.map(down));
  const errors = results.flatMap((result) => (result.status === "rejected" ? [String(result.reason)] : []));
  if (errors.length > 0) throw new Error(`Teardown of run ${runId} failed:\n${errors.join("\n")}`);
  await removeImages([prefix, `vsc-${prefix}`]);
}
