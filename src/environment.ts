import { closeSync, existsSync, fstatSync, linkSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeSync } from "node:fs";
import { lstat, mkdir, mkdtemp, readdir, readFile, readlink, realpath, rm, stat, statfs } from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { errorCode, message } from "./findings.ts";
import { flock } from "./logins.ts";
import { keepSeedSecrets, redact } from "./secrets.ts";
import { replaceFile } from "./state.ts";
import { capture, CommandTimeout, devContainerViolations, dockerConfig, execute, failure, isHttpUrl, targetEnv, type Target } from "./target.ts";
import { relayOutcomes, type ContainerStats, type GeneratedFile, type Mount, type RelayRecord } from "./types.ts";

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

export const devcontainer = fileURLToPath(import.meta.resolve("@devcontainers/cli/devcontainer.js"));
const gib = 1024 ** 3;
const mib = 1024 ** 2;
const runnerMemory = 4 * gib;
const sidecarMemory = 128 * mib;
const serviceMemory = gib;
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
const buildProject = "qa-build";
const imagePrefix = `${buildProject}-`;
const keyLength = 12;
const keepImages = 30 * minute;
const createDiskScript =
  'if [ -e "$2" ] || mountpoint -q "$1"; then echo "$1 already has an output disk" >&2; exit 1; fi; { truncate -s "$4" "$2.new" && mkfs.ext4 -q -F -m 0 -E root_owner="$3" "$2.new" && mount -o loop "$2.new" /mnt && rmdir /mnt/lost+found && umount /mnt && mv "$2.new" "$2" && mount -o loop,nosuid,nodev "$2" "$1"; } || { rm -f "$2.new"; exit 1; }';
const saveDiskScript =
  'rm -f "$2.new"; [ -e "$2" ] || exit 0; mkdir /under && mount --bind "${1%/*}" /under && { if mountpoint -q "$1"; then src="$1"; else mount -o loop "$2" /mnt && src=/mnt; fi; } && find "/under/${1##*/}" -mindepth 1 -delete && cp -a "$src/." "/under/${1##*/}" && umount "$src" && umount /under && rm "$2"';

const defaultSubnet = "10.213.0.0/16";
const slotBits = 23;

type Cidr = { address: number; bits: number };

const cidrSchema = z.union([z.ipv4(), z.cidrv4()]);

function readCidr(value: string): Cidr | null {
  if (!cidrSchema.safeParse(value).success) return null;
  const [address = "", prefix = "32"] = value.split("/");
  return { address: address.split(".").reduce((sum, octet) => sum * 256 + Number(octet), 0), bits: Number(prefix) };
}

function parseCidr(value: string): Cidr {
  const cidr = readCidr(value);
  if (cidr === null) throw new Error(`${value} is not an IPv4 address or CIDR block`);
  return cidr;
}

function formatAddress(address: number): string {
  return [24, 16, 8, 0].map((shift) => (address >>> shift) & 255).join(".");
}

export function networkRange(): { subnet: string; address: number; slots: number } {
  const subnet = process.env.QA_INTERNS_SUBNET ?? defaultSubnet;
  const cidr = readCidr(subnet);
  if (cidr === null || cidr.bits < 16 || cidr.bits > slotBits || cidr.address % 2 ** (32 - cidr.bits) !== 0) {
    throw new Error(`QA_INTERNS_SUBNET is ${JSON.stringify(subnet)}, and it must be an IPv4 network address with a prefix length from 16 to ${slotBits}, such as ${defaultSubnet}`);
  }
  return { subnet, address: cidr.address, slots: 2 ** (slotBits - cidr.bits) };
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

async function inspectNetworks(ids: string[]): Promise<z.infer<typeof networksSchema>> {
  if (ids.length === 0) return [];
  const cmd = ["docker", "network", "inspect", ...ids];
  const result = await capture(cmd);
  if (result.code === 0) return networksSchema.parse(JSON.parse(result.stdout));
  const listed = await networkIds();
  const left = ids.filter((id) => listed.includes(id));
  if (left.length === ids.length) throw failure(cmd, result.code, result.stderr);
  return inspectNetworks(left);
}

async function usedBlocks(): Promise<Cidr[]> {
  const networks = await inspectNetworks(await networkIds());
  const routes = routesSchema.parse(JSON.parse(await execute(["ip", "-4", "-j", "route", "show", "table", "all"])));
  const subnets = networks.flatMap((network) => (network.IPAM.Config ?? []).map((config) => config.Subnet)).filter((subnet) => !subnet.includes(":"));
  const destinations = routes.map((route) => route.dst).filter((dst) => dst !== "default");
  return [...subnets, ...destinations].map(parseCidr);
}

function slotAddress(slot: number, offset: number): string {
  const { address, slots } = networkRange();
  if (!Number.isInteger(slot) || slot < 0 || slot >= slots) throw new Error(`Slot ${slot} is not an integer from 0 to ${slots - 1}`);
  return formatAddress(address + slot * 2 ** (32 - slotBits) + offset);
}

export function slotSubnets(slot: number): { internal: string; relay: string; agent: string; egress: string } {
  return {
    internal: `${slotAddress(slot, 0)}/25`,
    relay: `${slotAddress(slot, 128)}/25`,
    agent: `${slotAddress(slot, 256)}/25`,
    egress: `${slotAddress(slot, 384)}/25`,
  };
}

function openSlots(used: Cidr[]): number[] {
  return Array.from({ length: networkRange().slots }, (_, slot) => slot).filter((slot) => {
    const blocks = Object.values(slotSubnets(slot)).map(parseCidr);
    return !used.some((block) => blocks.some((own) => overlaps(block, own)));
  });
}

export async function freeSlots(): Promise<number> {
  return openSlots(await usedBlocks()).length;
}

function runtimeDir(name: string, what: string): string {
  const runtime = process.env.XDG_RUNTIME_DIR;
  if (runtime === undefined || runtime === "") throw new Error(`XDG_RUNTIME_DIR is not set, and QA Interns keeps ${what} there`);
  const dir = join(runtime, "qa-interns", name);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

export type HeldSlot = { slot: number; release: () => void };

export async function freeSlot(): Promise<HeldSlot> {
  const dir = runtimeDir("slots", "the locks of its network slots");
  for (const slot of openSlots(await usedBlocks())) {
    const fd = flock(join(dir, `${slotAddress(slot, 0)}.lock`), "--exclusive", "--nonblock");
    if (fd === null) continue;
    let free = false;
    try {
      free = openSlots(await usedBlocks()).includes(slot);
    } finally {
      if (!free) closeSync(fd);
    }
    if (free) return { slot, release: () => closeSync(fd) };
  }
  throw new Error(`No free network slot: every /23 block of QA_INTERNS_SUBNET ${networkRange().subnet} overlaps a Docker network or a host route, or is locked for another QA Interns environment of this user`);
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
  const proxied = spec.egress.length > 0;
  const { internal, relay, agent, egress } = slotSubnets(spec.slot);
  const relayHosts = spec.target?.settings.egress ?? [];
  const relayAddress = slotAddress(spec.slot, 254);
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
    const memory = service.memLimit === null ? String(serviceMemory) : null;
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
  if (proxied) {
    lines.push(
      `  "qa-proxy":`,
      `    image: ${y(spec.runner.image)}`,
      `    pull_policy: ${y("never")}`,
      `    command: ${y(["node", "/opt/qa-interns/proxy.mjs"])}`,
      `    environment: ${y({ QA_PROXY_ALLOW: spec.egress.join(",") })}`,
      `    networks: ${y(["qa_agent", "qa_egress"])}`,
      ...hardening,
      `    mem_limit: ${y(String(sidecarMemory))}`,
      "    cpus: 0.5",
      "    pids_limit: 128",
    );
  }
  lines.push(
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
    "    pids_limit: 4096",
    `    ulimits: ${y({ fsize: outLimit })}`,
    `    mem_limit: ${y(String(runnerMemory))}`,
    "    cpus: 2",
    `    networks: ${y(["qa_internal", ...(proxied ? ["qa_agent"] : [])])}`,
  );
  if (relayHosts.length > 0) {
    lines.push(
      `  "qa-relay":`,
      `    image: ${y(spec.runner.image)}`,
      `    pull_policy: ${y("never")}`,
      `    command: ${y(["node", "/opt/qa-interns/relay.mjs"])}`,
      `    environment: ${y({ QA_RELAY_ALLOW: relayHosts.join(","), QA_RELAY_LIMITS: JSON.stringify(spec.target?.settings.connectionLimits ?? {}) })}`,
      `    networks: ${y({ qa_relay: { ipv4_address: relayAddress }, qa_egress: null })}`,
      `    healthcheck: ${y({ test: ["CMD", "node", "-e", relayProbe], start_period: "30s", start_interval: "500ms" })}`,
      ...hardening,
      `    mem_limit: ${y(String(sidecarMemory))}`,
      "    cpus: 0.5",
      "    pids_limit: 128",
    );
  }
  lines.push(
    "networks:",
    `  qa_internal: !override ${y(isolated(internal))}`,
    ...(relayHosts.length > 0 ? [`  qa_relay: !override ${y(isolated(relay))}`] : []),
    ...(proxied ? [`  qa_agent: !override ${y(isolated(agent))}`] : []),
    ...(proxied || relayHosts.length > 0 ? [`  qa_egress: !override ${y({ ipam: { config: [{ subnet: egress }] } })}`] : []),
  );
  return `${lines.join("\n")}\n`;
}

export function environmentMemory(target: Target | null): number {
  const services = Object.values(target?.services ?? {}).filter((service) => service.active);
  const relay = (target?.settings.egress.length ?? 0) > 0 ? sidecarMemory : 0;
  return services.reduce((sum, service) => sum + (service.memLimit ?? serviceMemory) * service.replicas, runnerMemory + sidecarMemory + relay);
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

export function imageBuilders(target: Target): Record<string, string> {
  const built = Object.entries(target.services).filter(([, service]) => service.build && service.active);
  const sources: Record<string, string> = Object.fromEntries(built.map(([name]) => [name, name]));
  for (const [name, service] of Object.entries(target.services)) {
    const wanted = service.build || !service.active || service.image === null ? null : imageReference(service.image);
    const builders = built.filter(([, other]) => [other.image, ...other.tags].some((ref) => ref !== null && imageReference(ref) === wanted)).map(([other]) => other);
    if (builders.length > 1) throw new Error(`Services ${builders.join(" and ")} both build the image ${service.image} that service ${name} runs, so which build it runs is undefined`);
    if (builders[0] !== undefined) sources[name] = builders[0];
  }
  return sources;
}

export type BuiltImages = { images: Record<string, string>; release: () => Promise<void> };

const buildConfigSchema = z.object({
  services: z.record(z.string(), z.object({ build: z.looseObject({ pull: z.boolean().optional(), no_cache: z.boolean().optional() }).optional(), platform: z.string().optional() })),
});
const buildCode = [import.meta.path, fileURLToPath(import.meta.resolve("./target.ts"))];

async function hashTree(hasher: Bun.CryptoHasher, root: string, entry = ""): Promise<void> {
  const path = join(root, entry);
  const info = await lstat(path);
  hasher.update(JSON.stringify([entry, info.mode, info.isFile() ? info.size : 0]));
  if (info.isFile()) for await (const chunk of Bun.file(path).stream()) hasher.update(chunk);
  else if (info.isSymbolicLink()) hasher.update(JSON.stringify(await readlink(path)));
  else if (info.isDirectory()) for (const name of (await readdir(path)).toSorted()) await hashTree(hasher, root, join(entry, name));
}

async function imageList(): Promise<{ id: string; name: string }[]> {
  const lines = (await execute(["docker", "image", "ls", "--format", "{{.ID}} {{.Repository}}:{{.Tag}}"])).split("\n").filter((line) => line !== "");
  return lines.map((line) => ({ id: line.slice(0, line.indexOf(" ")), name: line.slice(line.indexOf(" ") + 1) }));
}

function imageUses(): string {
  return runtimeDir("images", "the last use of each shared image");
}

async function tagShared(pairs: [string, string][]): Promise<boolean> {
  const names = new Set((await imageList()).map(({ name }) => name));
  if (pairs.some(([shared]) => !names.has(shared))) return false;
  for (const [shared, own] of pairs) {
    const cmd = ["docker", "tag", shared, own];
    const result = await capture(cmd);
    if (result.code === 0) continue;
    if ((await imageList()).some(({ name }) => name === shared)) throw failure(cmd, result.code, result.stderr);
    return false;
  }
  return true;
}

export async function buildImages(runId: string, target: Target, sourceDir: string, log: string): Promise<BuiltImages> {
  const own = (builder: string) => `qa-${runId}-${builder.toLowerCase()}:latest`;
  const images = Object.fromEntries(Object.entries(imageBuilders(target)).map(([name, builder]) => [name, own(builder)]));
  const services = Object.entries(target.services).filter(([, service]) => service.build && service.active).map(([name]) => name);
  if (services.length === 0) return { images, release: async () => {} };
  const dir = await mkdtemp(join(tmpdir(), "qa-interns-tags-"));
  try {
    const env = await targetEnv(target.settings.hostEnv, dir);
    const compose = ["docker", "compose", "-p", buildProject, ...sourceComposeArgs(target, sourceDir)];
    const config = buildConfigSchema.parse(JSON.parse(await execute([...compose, "config", "--format", "json", "--no-env-resolution", ...services], { env })));
    const builds = services.map((name) => {
      const service = config.services[name];
      if (service?.build === undefined) throw new Error(`docker compose config renders no build for service ${name} from the Compose files of ${sourceDir}`);
      return { name, build: service.build, platform: service.platform ?? null };
    });
    const hasher = new Bun.CryptoHasher("sha256");
    for (const file of buildCode) hasher.update(await readFile(file));
    const hostValues = target.settings.hostEnv.filter((name) => !target.settings.secrets.hostEnv.includes(name)).map((name) => [name, env[name] ?? null]);
    hasher.update(JSON.stringify([builds, hostValues]).replaceAll(sourceDir, ""));
    await hashTree(hasher, sourceDir);
    const key = hasher.digest("hex").slice(0, keyLength);
    const shared = (name: string) => `${imagePrefix}${key}-${name.toLowerCase()}:latest`;
    const use = join(imageUses(), key);
    const release = async () => {
      await Bun.write(use, "");
    };
    await release();
    const fresh = builds.some(({ build }) => build.pull === true || build.no_cache === true);
    if (!fresh && (await tagShared(services.map((name) => [shared(name), own(name)])))) return { images, release };
    const tags = join(dir, "tags.yml");
    const lines = services.flatMap((name) => [`  ${JSON.stringify(name)}:`, `    image: ${JSON.stringify(own(name))}`, "    build:", `      tags: !override ${JSON.stringify([shared(name)])}`]);
    await Bun.write(tags, `services:\n${lines.join("\n")}\n`);
    const cmd = [...compose, "-f", tags, "build", ...services];
    const result = await capture(cmd, { env, timeout: 30 * minute }).catch(async (error: unknown) => {
      if (!(error instanceof CommandTimeout)) throw error;
      await Bun.write(log, redact(`${error.stdout}\n${error.stderr}`));
      throw new Error(`${error.message} (log: ${log})`);
    });
    const output = `${result.stdout}\n${result.stderr}`;
    await Bun.write(log, redact(output));
    if (result.code !== 0) throw new Error(`${failure(cmd, result.code, output).message} (log: ${log})`);
    return { images, release };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export async function sweepImages(): Promise<void> {
  const uses = imageUses();
  const listed = await imageList();
  const held = new Set(listed.filter(({ name }) => name.startsWith("qa-") && !name.startsWith(imagePrefix)).map(({ id }) => id));
  const keys = Map.groupBy(listed.filter(({ name }) => name.startsWith(imagePrefix)), ({ name }) => name.slice(imagePrefix.length, imagePrefix.length + keyLength));
  const errors: string[] = [];
  for (const [key, images] of keys) {
    const use = join(uses, key);
    const used = await stat(use).then(
      (info) => info.mtimeMs,
      (error: unknown) => {
        if (errorCode(error) === "ENOENT") return null;
        throw error;
      },
    );
    if (used === null) await Bun.write(use, "");
    if (used === null || Date.now() - used < keepImages) continue;
    const names = images.filter(({ id }) => !held.has(id)).map(({ name }) => name);
    if (names.length === 0) continue;
    const cmd = ["docker", "image", "rm", ...names];
    const result = await capture(cmd);
    if (result.code !== 0 && (await imageList()).some(({ name }) => names.includes(name))) errors.push(failure(cmd, result.code, result.stderr).message);
    else if (names.length === images.length) await rm(use, { force: true });
  }
  if (errors.length > 0) throw new Error(`Removing shared images failed:\n${errors.join("\n")}`);
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

function qaServices(spec: EnvironmentSpec, target: Target): string[] {
  return [...(spec.egress.length > 0 ? ["qa-proxy"] : []), "qa-runner", ...(target.settings.egress.length > 0 ? ["qa-relay"] : [])];
}

function overrideConfig(spec: EnvironmentSpec, target: Target, composeFile: string): Record<string, unknown> {
  return {
    ...target.config,
    dockerComposeFile: [...target.composeFiles, composeFile],
    ...(target.runServices === undefined ? {} : { runServices: [...target.runServices, ...qaServices(spec, target)] }),
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
      throw new Error(`The ready check ${ready} did not pass within 5 minutes: exit ${result.code}, ${url ? `status ${result.stdout.trim()}, ` : ""}${redact(result.stderr).trim().slice(-500)}`);
    }
    await Bun.sleep(2000);
  }
}

export async function startEnvironment(spec: EnvironmentSpec, ready?: () => void): Promise<Environment> {
  const project = projectName(spec.runId, spec.name);
  const dir = envDir(spec);
  const log = join(dir, "env.log");
  await removeCopy(spec.runDir, spec.runId, spec.name, spec.runner.image);
  await writeFiles(spec);
  await createDisk(spec.runner.out, spec.runner.image, project);
  const tmp = join(dir, "tmp");
  if (spec.target === null) {
    await execute(["docker", "compose", "-p", project, ...composeArgs(spec), "up", "-d", "--wait", "--wait-timeout", waitTimeoutSeconds], { env: { ...process.env, DOCKER_CONFIG: await dockerConfig(tmp) }, log });
    ready?.();
    return { project, runner: await runnerId(project), out: spec.runner.out, devContainer: null, seed: null };
  }
  const target = spec.target;
  const env = await targetEnv(target.settings.hostEnv, tmp);
  const workspace = join(dir, project);
  const config = join(dir, "devcontainer.json");
  await execute(["cp", "-a", "--reflink=auto", join(spec.runDir, "source"), workspace]);
  await Bun.write(config, `${JSON.stringify(overrideConfig(spec, target, join(dir, "compose.qa.yml")), null, 2)}\n`);

  const upEnv = { ...env, COMPOSE_PROJECT_NAME: project, TMPDIR: tmp };
  const up = await capture(
    [process.execPath, devcontainer, "up", "--workspace-folder", workspace, "--override-config", config, "--user-data-folder", join(dir, "devcontainer-data"), "--id-label", `qa-interns.env=${project}`, "--log-format", "json"],
    { env: upEnv, log, timeout: 20 * minute },
  );
  const last = up.stdout.trim().split("\n").at(-1) ?? "";
  const result = upSchema.safeParse(last.startsWith("{") ? JSON.parse(last) : null);
  if (up.code !== 0 || !result.success || result.data.outcome !== "success" || result.data.containerId === undefined) {
    const detail = result.success ? [result.data.message, result.data.description].filter((part) => part !== undefined).join(" ") : redact(up.stderr).trim().slice(-2000);
    throw new Error(`devcontainer up for ${project} exited with ${up.code}: ${detail} (log: ${log})`);
  }
  const devContainer = result.data.containerId;
  const configFiles = await execute(["docker", "inspect", "--format", '{{index .Config.Labels "com.docker.compose.project.config_files"}}', devContainer]);
  const violations = await devContainerViolations(project, composeFiles(spec), configFiles.trim().split(","), target.service, workspace, upEnv);
  if (violations.length > 0) {
    throw new Error(`The dev container that devcontainer up created for ${project} cannot run as isolated copies:\n${violations.map((line) => `- ${line}`).join("\n")}`);
  }

  const services = target.runServices === undefined ? [] : [target.service, ...target.runServices, ...qaServices(spec, target)];
  await execute(
    ["docker", "compose", "-p", project, ...composeArgs(spec), "up", "-d", "--wait", "--wait-timeout", waitTimeoutSeconds, "--no-recreate", ...services],
    { env: upEnv, log },
  );
  const runner = await runnerId(project);
  const exec = [process.execPath, devcontainer, "exec", "--container-id", devContainer, "--workspace-folder", workspace, "--override-config", config];
  await waitReady(target.settings.ready, runner, exec, env, log);
  ready?.();
  const seedCommand = [...exec, "sh", "-c", target.settings.seed];
  const seeded = await capture(seedCommand, { env, log, timeout: 10 * minute }).then(
    (result) => ({ stdout: result.stdout, fail: result.code === 0 ? null : () => failure(seedCommand, result.code, result.stderr) }),
    (error: unknown) => {
      if (!(error instanceof CommandTimeout)) throw error;
      return { stdout: error.stdout, fail: () => new CommandTimeout(error.cmd, error.seconds, error.stdout, error.stderr) };
    },
  );
  let seed: unknown;
  try {
    seed = JSON.parse(seeded.stdout);
  } catch (error) {
    if (seeded.fail !== null) throw seeded.fail();
    throw new Error(`The seed command ${target.settings.seed} did not print one JSON document (${String(error)}); it printed: ${redact(seeded.stdout).slice(0, 500)}`);
  }
  const unkept = keepSeedSecrets(seed, target.settings.secrets.seed);
  if (seeded.fail !== null) throw seeded.fail();
  if (unkept !== null) throw new Error(unkept);
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

const mountsSchema = z.object({ filesystems: z.array(z.object({ target: z.string() })) });

export async function removeDir(dir: string, image: string, owner: string): Promise<void> {
  if (!existsSync(dir)) return;
  const real = await realpath(dir);
  const { filesystems } = mountsSchema.parse(JSON.parse(await execute(["findmnt", "--list", "--json", "--output", "TARGET"])));
  for (const { target } of filesystems.filter((mount) => mount.target.startsWith(`${real}/`))) await saveDisk(target, image, owner);
  await rm(dir, { recursive: true, force: true });
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

const inspectSchema = z.array(
  z.object({
    Id: z.string(),
    RestartCount: z.int(),
    State: z.object({ Status: z.string(), Running: z.boolean(), OOMKilled: z.boolean(), Pid: z.int() }),
    Config: z.object({ Labels: z.object({ "com.docker.compose.service": z.string(), "com.docker.compose.container-number": z.string().transform(Number).pipe(z.int().positive()) }) }),
  }),
);

async function readLive(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (errorCode(error) === "ENOENT" || errorCode(error) === "ESRCH") return null;
    throw error;
  }
}

export async function memoryPeak(id: string, pid: number): Promise<number | null> {
  const cgroups = await readLive(`/proc/${pid}/cgroup`);
  if (cgroups === null) return null;
  const unified = cgroups.split("\n").find((line) => line.startsWith("0::"));
  if (unified === undefined) throw new Error(`/proc/${pid}/cgroup of container ${id} has no cgroup v2 entry, and QA Interns reads peak memory from cgroup v2`);
  const parts = unified.slice(3).split("/");
  const own = parts.findIndex((part) => part.includes(id));
  if (own === -1) return null;
  const dir = join("/sys/fs/cgroup", ...parts.slice(0, own + 1));
  const peak = await readLive(join(dir, "memory.peak"));
  if (peak === null) {
    if (existsSync(dir)) throw new Error(`${dir} has no memory.peak, which needs Linux 5.19 or later with the cgroup v2 memory controller`);
    return null;
  }
  const bytes = Number(peak);
  if (!Number.isSafeInteger(bytes)) throw new Error(`${dir}/memory.peak holds ${JSON.stringify(peak)} instead of a byte count`);
  return bytes;
}

export async function containerStats(project: string): Promise<ContainerStats[]> {
  const ids = (await execute(["docker", "ps", "-aq", "--filter", `label=com.docker.compose.project=${project}`])).split("\n").filter((id) => id !== "");
  if (ids.length === 0) return [];
  const containers = inspectSchema.parse(JSON.parse(await execute(["docker", "inspect", "--type", "container", ...ids])));
  const stats = await Promise.all(
    containers.map(async ({ Id, RestartCount, State, Config }) => ({
      service: Config.Labels["com.docker.compose.service"],
      number: Config.Labels["com.docker.compose.container-number"],
      state: State.Status,
      oomKilled: State.OOMKilled,
      restarts: RestartCount,
      memoryPeak: State.Running ? await memoryPeak(Id, State.Pid) : null,
    })),
  );
  return stats.toSorted((a, b) => a.service.localeCompare(b.service) || a.number - b.number);
}

export const relaySchema = z.object({ n: z.number().int().positive(), host: z.string().nullable(), outcome: z.enum(relayOutcomes), error: z.string().nullable() });

const relayPrefix = "relay-";
const relaySuffix = ".jsonl";

export async function readRelayLogs(dir: string): Promise<RelayRecord[][]> {
  const names = existsSync(dir) ? (await readdir(dir)).filter((name) => name.startsWith(relayPrefix) && name.endsWith(relaySuffix)).sort() : [];
  return Promise.all(
    names.map(async (name) => {
      const lines = (await Bun.file(join(dir, name)).text()).split("\n").filter((line) => line !== "");
      return lines.map((line) => relaySchema.parse(JSON.parse(line)));
    }),
  );
}

async function saveRelayLogs(project: string, dir: string): Promise<void> {
  const labels = ["--filter", `label=com.docker.compose.project=${project}`, "--filter", "label=com.docker.compose.service=qa-relay"];
  const ids = (await execute(["docker", "ps", "-aq", ...labels])).split("\n").filter((id) => id !== "");
  if (ids.length > 0) mkdirSync(dir, { recursive: true });
  for (const id of ids) replaceFile(join(dir, `${relayPrefix}${id}${relaySuffix}`), await execute(["docker", "logs", id]));
}

async function down(project: string, relayDir: string | null): Promise<void> {
  await execute(["docker", "compose", "-p", project, "stop", "--timeout", "2"]);
  if (relayDir !== null) await saveRelayLogs(project, relayDir);
  await execute(["docker", "compose", "-p", project, "down", "-v", "--remove-orphans", "--rmi", "local", "--timeout", "2"]);
  const ids = await projectObjects(project);
  if (ids.length > 0) throw new Error(`docker compose down left objects of ${project} behind: ${ids.join(", ")}`);
}

export async function stopProject(project: string, relayDir: string): Promise<void> {
  if ((await projectObjects(project)).length > 0) await down(project, relayDir);
}

async function removeImages(prefixes: string[]): Promise<void> {
  const listed = (await execute(["docker", "image", "ls", "--format", "{{.Repository}}:{{.Tag}}"])).split("\n");
  const images = listed.filter((image) => prefixes.some((prefix) => image.startsWith(prefix)));
  if (images.length > 0) await execute(["docker", "image", "rm", ...images]);
}

async function removeAsRoot(dir: string, image: string, owner: string, paths: string[]): Promise<void> {
  const name = `${owner}-remove-${crypto.randomUUID().slice(0, 8)}`;
  await execute(["docker", "run", "--rm", "--name", name, "--label", `${diskLabel}=${owner}`, "--network", "none", "--user", "0:0", "-v", `${dir}:/env`, image, "rm", "-rf", ...paths.map((path) => `/env/${path}`)]);
}

export async function removeCopy(runDir: string, runId: string, name: string, image: string): Promise<void> {
  const dir = join(runDir, "envs", name);
  const paths = [projectName(runId, name), "tmp"].filter((path) => existsSync(join(dir, path)));
  if (paths.length > 0) await removeAsRoot(dir, image, projectName(runId, name), paths);
}

export async function stopEnvironment(runDir: string, name: string, project: string, image: string, removed?: () => void): Promise<void> {
  await down(project, join(runDir, "interns", name));
  removed?.();
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
    if (Date.now() >= deadline) throw new Error(`The helper containers ${running.join(", ")} of run ${runId} still run after ${helperTimeout / minute} minutes`);
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
  if (paths.length > 0) await removeAsRoot(envs, image, projectName(runId, "envs"), paths);
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

export async function stopRun(runDir: string, runId: string): Promise<void> {
  const prefix = `qa-${runId}-`;
  const listing = ["--filter", "label=com.docker.compose.project", "--format", '{{.Label "com.docker.compose.project"}}'];
  const found = await Promise.all([
    execute(["docker", "ps", "-a", ...listing]),
    execute(["docker", "network", "ls", ...listing]),
    execute(["docker", "volume", "ls", ...listing]),
  ]);
  const projects = [...new Set(found.join("\n").split("\n"))].filter((project) => project.startsWith(prefix));
  const kept = existsSync(runDir);
  const results = await Promise.allSettled(projects.map((project) => down(project, kept ? join(runDir, "interns", project.slice(prefix.length)) : null)));
  const errors = results.flatMap((result) => (result.status === "rejected" ? [String(result.reason)] : []));
  if (errors.length > 0) throw new Error(`Teardown of run ${runId} failed:\n${errors.join("\n")}`);
  await removeImages([prefix, `vsc-${prefix}`]);
}

export type HeldRun = { end: () => void };

function locksEntry(fd: number, entry: string): boolean {
  const current = statSync(entry, { throwIfNoEntry: false });
  const locked = fstatSync(fd);
  return current !== undefined && current.dev === locked.dev && current.ino === locked.ino;
}

export function holdRun(runId: string, runDir: string): HeldRun {
  const dir = runtimeDir("runs", "the locks of its runs");
  const entry = join(dir, runId);
  const pending = join(dir, `.${runId}.${process.pid}`);
  const fresh = flock(pending, "--exclusive", "--nonblock");
  if (fresh === null) throw new Error(`Another process holds ${pending}`);
  let fd = fresh;
  let created = true;
  try {
    writeSync(fresh, runDir);
    linkSync(pending, entry);
  } catch (error) {
    closeSync(fresh);
    if (errorCode(error) !== "EEXIST") throw error;
    const existing = flock(entry, "--exclusive", "--nonblock");
    if (existing === null) throw new Error(`Another process holds run ${runId}`);
    if (!locksEntry(existing, entry)) {
      closeSync(existing);
      throw new Error(`Another process replaced the file of run ${runId} while this process locked it`);
    }
    fd = existing;
    created = readFileSync(entry, "utf8") === "";
    if (created) writeSync(fd, runDir);
  } finally {
    rmSync(pending, { force: true });
  }
  let held = true;
  return {
    end: () => {
      if (!held) return;
      held = false;
      if (created) rmSync(entry, { force: true });
      closeSync(fd);
    },
  };
}

export async function sweepRuns(image: string): Promise<string[]> {
  const dir = runtimeDir("runs", "the locks of its runs");
  const runIds = readdirSync(dir).filter((name) => !name.startsWith("."));
  const errors = await Promise.all(
    runIds.map(async (runId) => {
      const entry = join(dir, runId);
      const fd = flock(entry, "--exclusive", "--nonblock");
      if (fd === null) return [];
      try {
        if (!locksEntry(fd, entry)) return [];
        const runDir = readFileSync(entry, "utf8");
        if (runDir !== "") {
          await stopRun(runDir, runId);
          await removeCopies(runDir, runId, image);
        }
        rmSync(entry, { force: true });
        return [];
      } catch (error) {
        return [`Removing what run ${runId} left after its process ended failed: ${message(error)}`];
      } finally {
        closeSync(fd);
      }
    }),
  );
  return errors.flat();
}
