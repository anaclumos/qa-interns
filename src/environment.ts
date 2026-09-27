import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rm, stat, statfs } from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { capture, devContainerViolations, dockerConfig, execute, failure, isHttpUrl, targetEnv, type Target } from "./target.ts";
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
const relayProbe = "require('node:net').connect(443, '127.0.0.1').on('connect', () => process.exit(0)).on('error', () => process.exit(1))";
const outLimit = gib;
const outCheckMs = 1000;
const fullBelow = 16 * mib;
const diskSuffix = ".img";
const diskLabel = "qa-interns.disk";
const helperTimeout = 10 * minute;
const createDiskScript =
  'if [ -e "$2" ] || mountpoint -q "$1"; then echo "$1 already has an output disk" >&2; exit 1; fi; { truncate -s "$4" "$2.new" && mkfs.ext4 -q -F -m 0 -E root_owner="$3" "$2.new" && mount -o loop "$2.new" /mnt && rmdir /mnt/lost+found && umount /mnt && mv "$2.new" "$2" && mount -o loop,nosuid,nodev "$2" "$1"; } || { rm -f "$2.new"; exit 1; }';
const saveDiskScript =
  'rm -f "$2.new"; [ -e "$2" ] || exit 0; if mountpoint -q "$1"; then umount "$1"; fi && mount -o loop "$2" /mnt && find "$1" -mindepth 1 -delete && cp -a /mnt/. "$1" && umount /mnt && rm "$2"';

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

export function slotSubnets(slot: number): { internal: string; relay: string; agent: string; egress: string } {
  if (!Number.isInteger(slot) || slot < 0 || slot > 127) throw new Error(`Slot ${slot} is not an integer from 0 to 127`);
  return {
    internal: `10.213.${slot * 2}.0/25`,
    relay: `10.213.${slot * 2}.128/25`,
    agent: `10.213.${slot * 2 + 1}.0/25`,
    egress: `10.213.${slot * 2 + 1}.128/25`,
  };
}

function openSlots(used: Cidr[], reserved: Set<number>): number[] {
  return Array.from({ length: 128 }, (_, slot) => slot).filter((slot) => {
    if (reserved.has(slot)) return false;
    const blocks = Object.values(slotSubnets(slot)).map(parseCidr);
    return !used.some((block) => blocks.some((own) => overlaps(block, own)));
  });
}

export async function freeSlots(reserved: Set<number>): Promise<number> {
  return openSlots(await usedBlocks(), reserved).length;
}

export async function freeSlot(reserved: Set<number>): Promise<number> {
  const [slot] = openSlots(await usedBlocks(), reserved);
  if (slot === undefined) throw new Error("No free network slot: every 10.213.x.0/23 block overlaps a Docker network, a host route, or a slot this run holds");
  reserved.add(slot);
  return slot;
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
  const { internal, relay, agent, egress } = slotSubnets(spec.slot);
  const relayHosts = spec.target?.settings.egress ?? [];
  const relayAddress = `10.213.${spec.slot * 2}.254`;
  const y = (value: unknown) => JSON.stringify(value);
  const isolated = (subnet: string) => ({ internal: true, driver_opts: { "com.docker.network.bridge.gateway_mode_ipv4": "isolated" }, ipam: { config: [{ subnet }] } });
  const logging = `    logging: !override ${y({ driver: "local", options: { "max-size": "10m", "max-file": "2" } })}`;
  const lines = ["services:"];
  for (const [name, service] of Object.entries(spec.target?.services ?? {})) {
    lines.push(`  ${y(name)}:`, "    ports: !reset []", logging);
    if (!service.networkMode?.startsWith("service:")) {
      const networks = { qa_internal: service.aliases.length > 0 ? { aliases: service.aliases } : null, ...(relayHosts.length > 0 ? { qa_relay: null } : {}) };
      lines.push(`    networks: !override ${y(networks)}`);
      if (relayHosts.length > 0) {
        lines.push(
          `    extra_hosts: ${y(Object.fromEntries(relayHosts.map((host) => [host, relayAddress])))}`,
          `    depends_on: ${y({ "qa-relay": { condition: "service_healthy" } })}`,
        );
      }
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
    logging,
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
  );
  if (relayHosts.length > 0) {
    lines.push(
      `  "qa-relay":`,
      `    image: ${y(spec.runner.image)}`,
      `    pull_policy: ${y("never")}`,
      `    command: ${y(["node", "/opt/qa-interns/relay.mjs"])}`,
      `    environment: ${y({ QA_RELAY_ALLOW: relayHosts.join(",") })}`,
      `    networks: ${y({ qa_relay: { ipv4_address: relayAddress }, qa_egress: null })}`,
      `    healthcheck: ${y({ test: ["CMD", "node", "-e", relayProbe], start_period: "30s", start_interval: "500ms" })}`,
      ...hardening,
      `    mem_limit: ${y("128m")}`,
      "    cpus: 0.5",
      "    pids_limit: 128",
    );
  }
  lines.push(
    "networks:",
    `  qa_internal: !override ${y(isolated(internal))}`,
    ...(relayHosts.length > 0 ? [`  qa_relay: !override ${y(isolated(relay))}`] : []),
    `  qa_agent: !override ${y(isolated(agent))}`,
    `  qa_egress: !override ${y({ ipam: { config: [{ subnet: egress }] } })}`,
  );
  return `${lines.join("\n")}\n`;
}

export function environmentMemory(target: Target | null): number {
  const services = Object.values(target?.services ?? {}).filter((service) => service.active);
  const relay = (target?.settings.egress.length ?? 0) > 0 ? 128 * mib : 0;
  return services.reduce((sum, service) => sum + (service.memLimit ?? gib) * service.replicas, 2 * gib + 128 * mib + relay);
}

function urlHosts(urls: Record<string, string>): string[] {
  return [...new Set(Object.values(urls).map((url) => new URL(url).hostname))];
}

export async function writeChromePolicy(runDir: string, urls: Record<string, string>): Promise<void> {
  const hosts = urlHosts(urls).filter((host) => !host.includes("."));
  const parsed = Object.values(urls).map((url) => new URL(url));
  const insecure = [...new Set(parsed.filter((url) => url.protocol === "http:").map((url) => url.origin))];
  const policy = { HSTSPolicyBypassList: hosts, OverrideSecurityRestrictionsOnInsecureOrigin: insecure };
  await Bun.write(join(runDir, "chrome-policy.json"), `${JSON.stringify(policy, null, 2)}\n`);
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

function imageReference(name: string): string {
  const [head = "", ...rest] = name.split("/");
  const hasDomain = rest.length > 0 && (head === "localhost" || head.includes(".") || head.includes(":") || head.toLowerCase() !== head);
  const domain = hasDomain && head !== "index.docker.io" ? head : "docker.io";
  const remote = hasDomain ? rest.join("/") : name;
  const path = domain === "docker.io" && !remote.includes("/") ? `library/${remote}` : remote;
  const last = path.slice(path.lastIndexOf("/") + 1);
  return `${domain}/${path}${last.includes(":") || last.includes("@") ? "" : ":latest"}`;
}

export async function buildImages(runId: string, target: Target, sourceDir: string): Promise<Record<string, string>> {
  const built = Object.entries(target.services).filter(([, service]) => service.build && service.active);
  const services = built.map(([name]) => name);
  const image = (name: string) => `qa-${runId}-${name.toLowerCase()}:latest`;
  const images = Object.fromEntries(services.map((name) => [name, image(name)]));
  for (const [name, service] of Object.entries(target.services)) {
    const wanted = service.build || !service.active || service.image === null ? null : imageReference(service.image);
    const builders = built.filter(([, other]) => [other.image, ...other.tags].some((ref) => ref !== null && imageReference(ref) === wanted)).map(([other]) => other);
    if (builders.length > 1) throw new Error(`Services ${builders.join(" and ")} both build the image ${service.image} that service ${name} runs, so which build it runs is undefined`);
    if (builders[0] !== undefined) images[name] = image(builders[0]);
  }
  if (services.length === 0) return images;
  const dir = await mkdtemp(join(tmpdir(), "qa-interns-tags-"));
  try {
    const tags = join(dir, "tags.yml");
    const lines = services.flatMap((name) => [`  ${JSON.stringify(name)}:`, `    image: ${JSON.stringify(images[name])}`, "    build:", "      tags: !reset []"]);
    await Bun.write(tags, `services:\n${lines.join("\n")}\n`);
    await execute(["docker", "compose", "-p", projectName(runId, "build"), ...sourceComposeArgs(target, sourceDir), "-f", tags, "build", ...services], {
      env: await targetEnv(target.settings.hostEnv, dir),
      timeout: 30 * minute,
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  return images;
}

function composeFiles(spec: EnvironmentSpec): string[] {
  const dir = envDir(spec);
  const workspace = join(dir, projectName(spec.runId, spec.name));
  const target = spec.target === null ? [] : spec.target.composeFiles.map((entry) => resolve(workspace, ".devcontainer", entry));
  return [...target, join(dir, "compose.qa.yml")];
}

function composeArgs(spec: EnvironmentSpec): string[] {
  return composeFiles(spec).flatMap((file) => ["-f", file]);
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

function qaServices(target: Target): string[] {
  return ["qa-proxy", "qa-runner", ...(target.settings.egress.length > 0 ? ["qa-relay"] : [])];
}

function overrideConfig(target: Target, composeFile: string): Record<string, unknown> {
  const runServices = target.config.runServices;
  return {
    ...target.config,
    dockerComposeFile: [...target.composeFiles, composeFile],
    ...(Array.isArray(runServices) ? { runServices: [...runServices, ...qaServices(target)] } : {}),
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
  await createDisk(spec.runner.out, spec.runner.image, project);
  const tmp = join(dir, "tmp");
  if (spec.target === null) {
    await execute(["docker", "compose", "-p", project, ...composeArgs(spec), "up", "-d", "--wait", "--wait-timeout", waitTimeoutSeconds], { env: { ...process.env, DOCKER_CONFIG: await dockerConfig(tmp) }, log });
    return { project, runner: await runnerId(project), out: spec.runner.out, devContainer: null, seed: null };
  }
  const target = spec.target;
  const env = await targetEnv(target.settings.hostEnv, tmp);
  const workspace = join(dir, project);
  const config = join(dir, "devcontainer.json");
  await execute(["cp", "-a", "--reflink=auto", join(spec.runDir, "source"), workspace]);
  await Bun.write(config, `${JSON.stringify(overrideConfig(target, join(dir, "compose.qa.yml")), null, 2)}\n`);

  const upEnv = { ...env, COMPOSE_PROJECT_NAME: project, TMPDIR: tmp };
  const up = await capture(
    [process.execPath, devcontainer, "up", "--workspace-folder", workspace, "--override-config", config, "--user-data-folder", join(dir, "devcontainer-data"), "--id-label", `qa-interns.env=${project}`, "--log-format", "json"],
    { env: upEnv, log, timeout: 20 * minute },
  );
  const last = up.stdout.trim().split("\n").at(-1) ?? "";
  const result = upSchema.safeParse(last.startsWith("{") ? JSON.parse(last) : null);
  if (up.code !== 0 || !result.success || result.data.outcome !== "success" || result.data.containerId === undefined) {
    const detail = result.success ? [result.data.message, result.data.description].filter((part) => part !== undefined).join(" ") : up.stderr.trim().slice(-2000);
    throw new Error(`devcontainer up for ${project} exited with ${up.code}: ${detail} (log: ${log})`);
  }
  const devContainer = result.data.containerId;
  const configFiles = await execute(["docker", "inspect", "--format", '{{index .Config.Labels "com.docker.compose.project.config_files"}}', devContainer]);
  const violations = await devContainerViolations(project, composeFiles(spec), configFiles.trim().split(","), target.service, workspace, upEnv);
  if (violations.length > 0) {
    throw new Error(`The dev container that devcontainer up created for ${project} cannot run as isolated copies:\n${violations.map((line) => `- ${line}`).join("\n")}`);
  }

  const runServices = target.config.runServices;
  const services = Array.isArray(runServices) ? [target.service, ...runServices, ...qaServices(target)] : [];
  await execute(
    ["docker", "compose", "-p", project, ...composeArgs(spec), "up", "-d", "--wait", "--wait-timeout", waitTimeoutSeconds, "--no-recreate", ...services],
    { env: upEnv, log },
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
  await disableRestarts(project);
  return { project, runner, out: spec.runner.out, devContainer, seed };
}

async function disableRestarts(project: string): Promise<void> {
  const label = `label=com.docker.compose.project=${project}`;
  const containers = (await execute(["docker", "ps", "-aq", "--filter", label])).split("\n").filter((id) => id !== "");
  await execute(["docker", "update", "--restart", "no", ...containers]);
  while ((await execute(["docker", "ps", "-aq", "--filter", label, "--filter", "status=restarting"])).trim() !== "") await Bun.sleep(1000);
}

async function diskHelper(out: string, image: string, owner: string, script: string, args: string[]): Promise<void> {
  const dir = dirname(out);
  const name = `${owner}-disk-${crypto.randomUUID().slice(0, 8)}`;
  const mounts = ["-v", "/dev:/dev", "-v", `${dir}:${dir}:rshared`];
  await execute(["docker", "run", "--rm", "--name", name, "--label", `${diskLabel}=${owner}`, "--privileged", "--network", "none", "--user", "0:0", ...mounts, image, "flock", dir, "sh", "-c", script, "sh", out, `${out}${diskSuffix}`, ...args]);
}

export async function createDisk(out: string, image: string, owner: string): Promise<void> {
  const { uid, gid } = userInfo();
  await diskHelper(out, image, owner, createDiskScript, [`${uid}:${gid}`, String(outLimit)]);
  if ((await stat(out)).dev === (await stat(dirname(out))).dev) {
    throw new Error(`The output disk of ${out} is mounted where Docker runs but not where QA Interns runs. Put the state directory on a mount with shared propagation.`);
  }
}

export async function saveDisk(out: string, image: string, owner: string): Promise<void> {
  await diskHelper(out, image, owner, saveDiskScript, []);
}

async function diskOuts(dir: string): Promise<string[]> {
  const names = existsSync(dir) ? await readdir(dir) : [];
  const suffixes = [diskSuffix, `${diskSuffix}.new`];
  return [...new Set(names.flatMap((name) => suffixes.filter((suffix) => name.endsWith(suffix)).map((suffix) => join(dir, name.slice(0, -suffix.length)))))];
}

export async function watchOut(dir: string, signal: AbortSignal): Promise<string> {
  for (;;) {
    await Bun.sleep(outCheckMs);
    signal.throwIfAborted();
    const { bavail, bsize, ffree } = await statfs(dir);
    if (bavail * bsize < fullBelow || ffree === 0) return `${dir} filled its ${outLimit / gib} GiB disk`;
  }
}

async function projectObjects(project: string): Promise<string[]> {
  const label = `label=com.docker.compose.project=${project}`;
  const left = await Promise.all([
    execute(["docker", "ps", "-aq", "--filter", label]),
    execute(["docker", "network", "ls", "-q", "--filter", label]),
    execute(["docker", "volume", "ls", "-q", "--filter", label]),
  ]);
  return left.join("\n").split("\n").filter((id) => id !== "");
}

async function down(project: string): Promise<void> {
  await execute(["docker", "compose", "-p", project, "down", "-v", "--remove-orphans", "--rmi", "local", "--timeout", "2"]);
  const ids = await projectObjects(project);
  if (ids.length > 0) throw new Error(`docker compose down left objects of ${project} behind: ${ids.join(", ")}`);
}

export async function stopProject(project: string): Promise<void> {
  if ((await projectObjects(project)).length > 0) await down(project);
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
  await saveDisks(runDir, name, project, image);
}

export async function saveDisks(runDir: string, name: string, project: string, image: string): Promise<void> {
  for (const out of await diskOuts(join(runDir, "interns", name))) await saveDisk(out, image, project);
}

async function diskHelpers(runId: string, state: "created" | "running"): Promise<string[]> {
  const listed = await execute(["docker", "ps", "-a", "--filter", `label=${diskLabel}`, "--filter", `status=${state}`, "--format", `{{.ID}} {{.Label "${diskLabel}"}}`]);
  return listed.split("\n").flatMap((line) => {
    const [id, owner] = line.split(" ");
    return id !== undefined && owner !== undefined && owner.startsWith(`qa-${runId}-`) ? [id] : [];
  });
}

async function settleDiskHelpers(runId: string): Promise<void> {
  const created = await diskHelpers(runId, "created");
  if (created.length > 0) await execute(["docker", "rm", "-f", ...created]);
  const deadline = Date.now() + helperTimeout;
  for (let running = await diskHelpers(runId, "running"); running.length > 0; running = await diskHelpers(runId, "running")) {
    if (Date.now() >= deadline) throw new Error(`The disk helpers ${running.join(", ")} of run ${runId} still run after ${helperTimeout / minute} minutes`);
    await Bun.sleep(1000);
  }
}

export async function removeCopies(runDir: string, runId: string, image: string): Promise<void> {
  await settleDiskHelpers(runId);
  const envs = join(runDir, "envs");
  const names = existsSync(envs) ? await readdir(envs) : [];
  const paths = names.flatMap((name) => [join(name, projectName(runId, name)), join(name, "tmp")]).filter((path) => existsSync(join(envs, path)));
  const disks = (await Promise.all(names.map(async (name) => (await diskOuts(join(runDir, "interns", name))).map((out) => ({ out, owner: projectName(runId, name) }))))).flat();
  if (paths.length === 0 && disks.length === 0) return;
  if ((await capture(["docker", "image", "inspect", image])).code !== 0) {
    const left = [...paths.map((path) => join(envs, path)), ...disks.map((disk) => `the output disk of ${disk.out}`)];
    throw new Error(`${runDir} still holds ${left.join(", ")}, which only a container of the runner image can save or remove, and the runner image ${image} does not exist. Build it with qa-interns doctor, then run qa-interns down again.`);
  }
  if (paths.length > 0) await removeAsRoot(envs, image, paths);
  const errors: string[] = [];
  for (const { out, owner } of disks) {
    try {
      await saveDisk(out, image, owner);
    } catch (error) {
      errors.push(String(error));
    }
  }
  if (errors.length > 0) throw new Error(`Saving the output disks of ${runDir} failed:\n${errors.join("\n")}`);
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
