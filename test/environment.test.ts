import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { cp, mkdir, mkdtemp, readdir, stat, symlink, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { z } from "zod";
import {
  buildImages,
  containerStats,
  createDisk,
  freeSlot,
  freeSlots,
  readRelayLogs,
  removeCopies,
  removeDir,
  renderOverride,
  runnerEnv,
  saveDisk,
  slotSubnets,
  startEnvironment,
  stopEnvironment,
  stopProject,
  stopRun,
  sweepImages,
  writeChromePolicy,
  type EnvironmentSpec,
  type HeldSlot,
} from "../src/environment.ts";
import { ensureRunnerImage, runnerImage } from "../src/runner.ts";
import { forgetSecrets, redact } from "../src/secrets.ts";
import { capture, execute, loadTarget, type Target } from "../src/target.ts";
import type { RelayRecord } from "../src/types.ts";
import { freeBlock } from "./subnet.ts";
import { suiteLabel } from "./suite-lock.ts";

const dockerAvailable = Bun.spawnSync(["docker", "info"], { stdout: "ignore", stderr: "ignore" }).exitCode === 0;

const ledgerSource = join(import.meta.dir, "..", "eval", "ledger");
const ref = { repo: "/home/dev/ledger", path: "", commit: "4f1c2a9e0b7d3c5a8e6f1d2b9c0a7e3f5d8b1c4a", dirty: false };
const roots: string[] = [];

afterAll(async () => {
  const image = await runnerImage();
  for (const root of roots) await removeDir(root, image, "qair-t-cleanup");
});

async function scratch(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "qa-interns-env-"));
  roots.push(root);
  return root;
}

const heldSlots: HeldSlot[] = [];

afterEach(() => {
  for (const held of heldSlots.splice(0)) held.release();
});

async function takeSlot(): Promise<number> {
  const held = await freeSlot();
  heldSlots.push(held);
  return held.slot;
}

async function imageIds(): Promise<Map<string, string>> {
  const lines = (await execute(["docker", "image", "ls", "--format", "{{.Repository}}:{{.Tag}} {{.ID}}"])).split("\n").filter((line) => line !== "");
  return new Map(lines.map((line) => [line.slice(0, line.indexOf(" ")), line.slice(line.indexOf(" ") + 1)]));
}

async function sharedTags(images: string[]): Promise<string[]> {
  const ids = await imageIds();
  const own = new Set(images.map((image) => ids.get(image)));
  return [...ids].filter(([name, id]) => name.startsWith("qa-build-") && own.has(id)).map(([name]) => name);
}

function spec(runDir: string, target: Target | null, overrides: Partial<EnvironmentSpec> = {}): EnvironmentSpec {
  const urls = target?.settings.urls ?? {};
  return {
    runId: "3f9a1c2e",
    runDir,
    name: "i1",
    slot: 3,
    target,
    images: {},
    runner: {
      image: "qa-interns-runner:0.1.0",
      out: join(runDir, "interns", "i1", "out"),
      env: { ...runnerEnv(urls), CLAUDE_CONFIG_DIR: "/qa/login", DISABLE_AUTOUPDATER: "1" },
      mounts: [{ source: "/home/dev/.local/share/claude-1", target: "/qa/login", readOnly: false }],
      files: [{ target: "/home/qa/.codex/config.toml", content: "[features]\napps = false\n" }],
      tmpfs: ["/home/qa/.codex"],
    },
    egress: ["api.anthropic.com", "platform.claude.com"],
    ...overrides,
  };
}

type Normalized = {
  services: Record<string, Record<string, unknown> & { networks?: Record<string, unknown> }>;
  networks: Record<string, Record<string, unknown>>;
};

async function withSubnet(subnet: string, check: () => void | Promise<void>): Promise<void> {
  const previous = process.env.QA_INTERNS_SUBNET;
  process.env.QA_INTERNS_SUBNET = subnet;
  try {
    await check();
  } finally {
    if (previous === undefined) delete process.env.QA_INTERNS_SUBNET;
    else process.env.QA_INTERNS_SUBNET = previous;
  }
}

async function normalize(runDir: string, composeFiles: string[], override: string): Promise<Normalized> {
  const file = join(runDir, "compose.qa.yml");
  await Bun.write(file, override);
  const args = [...composeFiles, file].flatMap((path) => ["-f", path]);
  const proc = Bun.spawnSync(["docker", "compose", "-p", "qa-render-check", ...args, "config", "--format", "json"], { stderr: "pipe" });
  if (proc.exitCode !== 0) throw new Error(proc.stderr.toString());
  return JSON.parse(proc.stdout.toString());
}

describe.skipIf(!dockerAvailable)("slots", () => {
  test("map a slot to its internal, relay, agent, and egress subnets", () => {
    expect(slotSubnets(0)).toEqual({ internal: "10.213.0.0/25", relay: "10.213.0.128/25", agent: "10.213.1.0/25", egress: "10.213.1.128/25" });
    expect(slotSubnets(3)).toEqual({ internal: "10.213.6.0/25", relay: "10.213.6.128/25", agent: "10.213.7.0/25", egress: "10.213.7.128/25" });
    expect(slotSubnets(127)).toEqual({ internal: "10.213.254.0/25", relay: "10.213.254.128/25", agent: "10.213.255.0/25", egress: "10.213.255.128/25" });
  });

  test.each([-1, 128, 1.5])("reject slot %p", (slot) => {
    expect(() => slotSubnets(slot)).toThrow("is not an integer from 0 to 127");
  });

  test("map a slot into the range that QA_INTERNS_SUBNET sets", async () => {
    await withSubnet("10.100.4.0/22", () => {
      expect(slotSubnets(0)).toEqual({ internal: "10.100.4.0/25", relay: "10.100.4.128/25", agent: "10.100.5.0/25", egress: "10.100.5.128/25" });
      expect(slotSubnets(1)).toEqual({ internal: "10.100.6.0/25", relay: "10.100.6.128/25", agent: "10.100.7.0/25", egress: "10.100.7.128/25" });
      expect(() => slotSubnets(2)).toThrow("Slot 2 is not an integer from 0 to 1");
    });
    await withSubnet("192.168.254.0/23", () => {
      expect(slotSubnets(0)).toEqual({ internal: "192.168.254.0/25", relay: "192.168.254.128/25", agent: "192.168.255.0/25", egress: "192.168.255.128/25" });
      expect(() => slotSubnets(1)).toThrow("Slot 1 is not an integer from 0 to 0");
    });
  });

  test.each(["", "10.213.0.0", "10.213.0.0/15", "10.213.0.0/24", "10.213.1.0/16", "10.213.0/16", "010.213.0.0/16", "1e1.213.0.0/16", " 10.213.0.0/16", "10.213.0.0/016", "10.213.0.0/16 ", "10.213.0.0/16/16", "256.0.0.0/16", "fd00::/48"])(
    "reject QA_INTERNS_SUBNET %p",
    async (subnet) => {
      await withSubnet(subnet, async () => {
        const message = `QA_INTERNS_SUBNET is ${JSON.stringify(subnet)}, and it must be an IPv4 network address with a prefix length from 16 to 23`;
        expect(() => slotSubnets(0)).toThrow(message);
        await expect(freeSlots()).rejects.toThrow(message);
      });
    },
  );

  test("give concurrent callers different slots", async () => {
    const held = await Promise.all([freeSlot(), freeSlot(), freeSlot()]);
    heldSlots.push(...held);
    expect(new Set(held.map((entry) => entry.slot)).size).toBe(3);
  });

  test("skip a slot that another process holds until that process ends", async () => {
    await withSubnet(`10.215.${await freeBlock(215)}.0/22`, async () => {
      const module = join(import.meta.dir, "..", "src", "environment.ts");
      const holder = Bun.spawn([process.execPath, "-e", `const { freeSlot } = await import(${JSON.stringify(module)}); console.log((await freeSlot()).slot); await Bun.sleep(600000);`], {
        env: { ...process.env },
        stdout: "pipe",
      });
      try {
        const { value } = await holder.stdout.getReader().read();
        expect(new TextDecoder().decode(value).trim()).toBe("0");
        expect(await takeSlot()).toBe(1);
        await expect(freeSlot()).rejects.toThrow("No free network slot");
      } finally {
        holder.kill("SIGKILL");
        await holder.exited;
      }
      expect(await takeSlot()).toBe(0);
    });
  });

  async function withNetwork(subnet: string, check: () => Promise<void>): Promise<void> {
    const name = `qa-btest-${crypto.randomUUID().slice(0, 8)}`;
    const proc = Bun.spawnSync(["docker", "network", "create", "--internal", "--label", suiteLabel, "--subnet", subnet, name], { stderr: "pipe" });
    if (proc.exitCode !== 0) throw new Error(proc.stderr.toString());
    try {
      await check();
    } finally {
      Bun.spawnSync(["docker", "network", "rm", name]);
    }
  }

  test("skip slots that overlap a larger Docker network", async () => {
    const range = `10.215.${await freeBlock(215)}.0/22`;
    await withSubnet(range, () =>
      withNetwork(range, async () => {
        expect(await freeSlots()).toBe(0);
        await expect(freeSlot()).rejects.toThrow("No free network slot");
      }),
    );
  });

  test.each([
    [2, 64],
    [2, 192],
    [3, 64],
    [3, 192],
  ])("skip and leave out of the count a slot that overlaps a smaller Docker network at offset %i.%i/26", async (block, address) => {
    const third = await freeBlock(215);
    await withSubnet(`10.215.${third}.0/22`, () =>
      withNetwork(`10.215.${third + block}.${address}/26`, async () => {
        expect(await freeSlots()).toBe(1);
        expect(await takeSlot()).toBe(0);
        await expect(freeSlot()).rejects.toThrow("No free network slot");
      }),
    );
  });
});

describe.skipIf(!dockerAvailable)("renderOverride", () => {
  test("isolate the Ledger target and add the runner and proxy", async () => {
    const target = await loadTarget(ref, ledgerSource);
    const runDir = await scratch();
    const environment = spec(runDir, target, { images: { web: "qa-3f9a1c2e-web:latest" } });
    const config = await normalize(runDir, [join(ledgerSource, ".devcontainer", "compose.yml")], renderOverride(environment, 1234, 2345));

    expect(Object.keys(config.services).sort()).toEqual(["db", "qa-proxy", "qa-runner", "web"]);
    const { web, db } = config.services;
    expect(web).toMatchObject({ image: "qa-3f9a1c2e-web:latest", mem_limit: "1073741824", cpus: 2, pids_limit: 1024 });
    expect(web?.build).toBeUndefined();
    expect(web?.ports).toBeUndefined();
    expect(web?.extra_hosts).toBeUndefined();
    expect(Object.keys(web?.networks ?? {})).toEqual(["qa_internal"]);
    expect(db).toMatchObject({ image: "postgres:17.11-alpine", mem_limit: "1073741824", cpus: 2, pids_limit: 1024 });
    expect(Object.keys(db?.networks ?? {})).toEqual(["qa_internal"]);

    expect(config.services["qa-proxy"]).toMatchObject({
      image: "qa-interns-runner:0.1.0",
      command: ["node", "/opt/qa-interns/proxy.mjs"],
      environment: { QA_PROXY_ALLOW: "api.anthropic.com,platform.claude.com" },
      init: true,
      read_only: true,
      cap_drop: ["ALL"],
      security_opt: ["no-new-privileges:true"],
      mem_limit: "134217728",
      cpus: 0.5,
      pids_limit: 128,
    });
    expect(Object.keys(config.services["qa-proxy"]?.networks ?? {}).sort()).toEqual(["qa_agent", "qa_egress"]);

    const runner = config.services["qa-runner"];
    expect(runner).toMatchObject({
      image: "qa-interns-runner:0.1.0",
      init: true,
      read_only: true,
      cap_drop: ["ALL"],
      security_opt: ["no-new-privileges:true"],
      mem_limit: "4294967296",
      cpus: 2,
      pids_limit: 4096,
      ulimits: { fsize: 1073741824 },
      tmpfs: [
        "/tmp:rw,nosuid,nodev,size=1g",
        "/home/qa:rw,nosuid,nodev,size=256m,uid=1234,gid=2345,mode=0700",
        "/home/qa/.codex:rw,nosuid,nodev,size=64m,uid=1234,gid=2345,mode=0700",
      ],
      environment: environment.runner.env,
    });
    expect(Object.keys(runner?.networks ?? {}).sort()).toEqual(["qa_agent", "qa_internal"]);
    const volumes = z.array(z.object({ type: z.string(), source: z.string(), target: z.string(), read_only: z.boolean().default(false) }));
    expect(volumes.parse(runner?.volumes)).toEqual([
      { type: "bind", source: join(runDir, "interns", "i1", "out"), target: "/qa/out", read_only: false },
      {
        type: "bind",
        source: join(runDir, "chrome-policy.json"),
        target: "/etc/opt/chrome_for_testing/policies/managed/qa-interns.json",
        read_only: true,
      },
      { type: "bind", source: "/home/dev/.local/share/claude-1", target: "/qa/login", read_only: false },
      {
        type: "bind",
        source: join(runDir, "envs", "i1", "files", "home", "qa", ".codex", "config.toml"),
        target: "/home/qa/.codex/config.toml",
        read_only: false,
      },
    ]);

    expect(config.networks.qa_internal).toMatchObject({
      internal: true,
      driver_opts: { "com.docker.network.bridge.gateway_mode_ipv4": "isolated" },
      ipam: { config: [{ subnet: "10.213.6.0/25" }] },
    });
    expect(config.networks.qa_agent).toMatchObject({
      internal: true,
      driver_opts: { "com.docker.network.bridge.gateway_mode_ipv4": "isolated" },
      ipam: { config: [{ subnet: "10.213.7.0/25" }] },
    });
    expect(config.networks.qa_egress).toMatchObject({ ipam: { config: [{ subnet: "10.213.7.128/25" }] } });
    expect(config.networks.qa_egress?.internal).toBeUndefined();
    expect(config.networks.qa_relay).toBeUndefined();
  });

  test("relay the target's egress hosts through qa-relay on a network the runner does not join", async () => {
    const source = await scratch();
    await Bun.write(
      join(source, ".devcontainer", "devcontainer.json"),
      JSON.stringify({
        dockerComposeFile: "compose.yml",
        service: "api",
        customizations: {
          "qa-interns": {
            urls: { app: "http://api:8080" },
            ready: "http://api:8080/ready",
            seed: "node seed.mjs",
            egress: ["api.pwnedpasswords.com", "ai-gateway.vercel.sh"],
            connectionLimits: { "ai-gateway.vercel.sh": { concurrent: 2, total: 300 } },
          },
        },
      }),
    );
    await Bun.write(
      join(source, ".devcontainer", "compose.yml"),
      `services:
  api:
    build: ..
    depends_on: ["db"]
    networks:
      default:
        aliases: ["shop"]
  db:
    image: postgres:17-alpine
  metrics:
    image: prom/statsd-exporter:v0.28.0
    network_mode: "service:db"
networks:
  qa_relay:
    driver: macvlan
`,
    );
    const target = await loadTarget(ref, source);
    const runDir = await scratch();
    const config = await normalize(runDir, [join(source, ".devcontainer", "compose.yml")], renderOverride(spec(runDir, target), 1000, 1000));

    expect(Object.keys(config.services).sort()).toEqual(["api", "db", "metrics", "qa-proxy", "qa-relay", "qa-runner"]);
    expect(config.networks.qa_relay?.driver).toBeUndefined();
    const hosts = ["ai-gateway.vercel.sh=10.213.6.254", "api.pwnedpasswords.com=10.213.6.254"];
    const relayReady = { "qa-relay": { condition: "service_healthy" } };
    expect(config.services.api).toMatchObject({
      networks: { qa_internal: { aliases: ["shop"] }, qa_relay: null },
      extra_hosts: hosts,
      depends_on: { db: { condition: "service_started" }, ...relayReady },
    });
    expect(config.services.db).toMatchObject({ networks: { qa_internal: null, qa_relay: null }, extra_hosts: hosts, depends_on: relayReady });
    expect(config.services.metrics?.networks).toBeUndefined();
    expect(config.services.metrics?.extra_hosts).toBeUndefined();

    expect(config.services["qa-relay"]).toMatchObject({
      image: "qa-interns-runner:0.1.0",
      command: ["node", "/opt/qa-interns/relay.mjs"],
      environment: { QA_RELAY_ALLOW: "api.pwnedpasswords.com,ai-gateway.vercel.sh", QA_RELAY_LIMITS: '{"ai-gateway.vercel.sh":{"concurrent":2,"total":300}}' },
      networks: { qa_relay: { ipv4_address: "10.213.6.254" }, qa_egress: null },
      healthcheck: { start_period: "30s", start_interval: "500ms" },
      logging: { driver: "local", options: { "max-size": "10m", "max-file": "2" } },
      init: true,
      read_only: true,
      cap_drop: ["ALL"],
      security_opt: ["no-new-privileges:true"],
      mem_limit: "134217728",
      cpus: 0.5,
      pids_limit: 128,
    });
    expect(Object.keys(config.services["qa-runner"]?.networks ?? {}).sort()).toEqual(["qa_agent", "qa_internal"]);
    expect(Object.keys(config.services["qa-proxy"]?.networks ?? {}).sort()).toEqual(["qa_agent", "qa_egress"]);
    expect(config.networks.qa_relay).toMatchObject({
      internal: true,
      driver_opts: { "com.docker.network.bridge.gateway_mode_ipv4": "isolated" },
      ipam: { config: [{ subnet: "10.213.6.128/25" }] },
    });

    await withSubnet("10.100.4.0/22", async () => {
      const moved = await normalize(runDir, [join(source, ".devcontainer", "compose.yml")], renderOverride(spec(runDir, target, { slot: 1 }), 1000, 1000));
      expect(moved.services.api?.extra_hosts).toEqual(["ai-gateway.vercel.sh=10.100.6.254", "api.pwnedpasswords.com=10.100.6.254"]);
      expect(moved.services["qa-relay"]?.networks).toEqual({ qa_relay: { ipv4_address: "10.100.6.254" }, qa_egress: null });
      expect(moved.networks).toMatchObject({
        qa_internal: { ipam: { config: [{ subnet: "10.100.6.0/25" }] } },
        qa_relay: { ipam: { config: [{ subnet: "10.100.6.128/25" }] } },
        qa_agent: { ipam: { config: [{ subnet: "10.100.7.0/25" }] } },
        qa_egress: { ipam: { config: [{ subnet: "10.100.7.128/25" }] } },
      });
    });
  });

  test("keep a shared network namespace and the target's own limits", async () => {
    const source = await scratch();
    await Bun.write(
      join(source, ".devcontainer", "devcontainer.json"),
      JSON.stringify({
        dockerComposeFile: "compose.yml",
        service: "api",
        customizations: { "qa-interns": { urls: { app: "http://api:8080" }, ready: "http://api:8080/ready", seed: "node seed.mjs" } },
      }),
    );
    await Bun.write(
      join(source, ".devcontainer", "compose.yml"),
      `services:
  api:
    build: ..
    deploy:
      resources:
        limits:
          cpus: "1.5"
          memory: 512M
    ports: ["8080:8080"]
  db:
    image: postgres:17-alpine
    mem_limit: 256m
    pids_limit: 300
  metrics:
    image: prom/statsd-exporter:v0.28.0
    network_mode: "service:db"
`,
    );
    const target = await loadTarget(ref, source);
    const runDir = await scratch();
    const config = await normalize(runDir, [join(source, ".devcontainer", "compose.yml")], renderOverride(spec(runDir, target), 1000, 1000));

    const { api, db, metrics } = config.services;
    expect(api?.deploy).toEqual({ resources: { limits: { cpus: 1.5, memory: "536870912", pids: 1024 } }, placement: {} });
    expect(api?.mem_limit).toBeUndefined();
    expect(api?.cpus).toBeUndefined();
    expect(api?.pids_limit).toBeUndefined();
    expect(api?.ports).toBeUndefined();
    expect(api?.build).toBeDefined();
    expect(db).toMatchObject({ mem_limit: "268435456", cpus: 2, pids_limit: 300 });
    expect(metrics).toMatchObject({ network_mode: "service:db", mem_limit: "1073741824", cpus: 2, pids_limit: 1024 });
    expect(metrics?.networks).toBeUndefined();
  });

  test("replace the log settings of every service with the local driver and two files of 10 MB, whatever the target sets", async () => {
    const source = await scratch();
    await Bun.write(
      join(source, ".devcontainer", "devcontainer.json"),
      JSON.stringify({
        dockerComposeFile: "compose.yml",
        service: "api",
        customizations: { "qa-interns": { urls: { app: "http://api:8080" }, ready: "http://api:8080/ready", seed: "node seed.mjs" } },
      }),
    );
    await Bun.write(
      join(source, ".devcontainer", "compose.yml"),
      `services:
  api:
    build: ..
    logging:
      driver: json-file
      options:
        max-size: 1g
  db:
    image: postgres:17-alpine
    logging:
      options:
        tag: db
  cache:
    image: redis:8-alpine
`,
    );
    const target = await loadTarget(ref, source);
    const runDir = await scratch();
    const config = await normalize(runDir, [join(source, ".devcontainer", "compose.yml")], renderOverride(spec(runDir, target), 1000, 1000));
    const capped = { driver: "local", options: { "max-size": "10m", "max-file": "2" } };
    expect(Object.fromEntries(Object.entries(config.services).map(([name, service]) => [name, service.logging]))).toEqual({
      api: capped,
      db: capped,
      cache: capped,
      "qa-proxy": capped,
      "qa-runner": capped,
    });
  });

  test("carry a service's network aliases onto the internal network when a URL host is an alias", async () => {
    const source = await scratch();
    await Bun.write(
      join(source, ".devcontainer", "devcontainer.json"),
      JSON.stringify({
        dockerComposeFile: "compose.yml",
        service: "api",
        customizations: { "qa-interns": { urls: { app: "http://shop:8080" }, ready: "http://shop:8080/ready", seed: "node seed.mjs" } },
      }),
    );
    await Bun.write(
      join(source, ".devcontainer", "compose.yml"),
      `services:
  api:
    build: ..
    networks:
      front:
        aliases: ["shop"]
      back:
        aliases: ["api-internal", "shop"]
  db:
    image: postgres:17-alpine
    networks: ["back"]
networks:
  front: {}
  back: {}
`,
    );
    const target = await loadTarget(ref, source);
    expect(target.services.api?.aliases).toEqual(["api-internal", "shop"]);
    expect(target.services.db?.aliases).toEqual([]);
    const runDir = await scratch();
    const config = await normalize(runDir, [join(source, ".devcontainer", "compose.yml")], renderOverride(spec(runDir, target), 1000, 1000));
    expect(config.services.api?.networks).toEqual({ qa_internal: { aliases: ["api-internal", "shop"] } });
    expect(config.services.db?.networks).toEqual({ qa_internal: null });
  });

  test("render a runner-only environment for the judge", async () => {
    const runDir = await scratch();
    const config = await normalize(runDir, [], renderOverride(spec(runDir, null), 1000, 1000));
    expect(Object.keys(config.services).sort()).toEqual(["qa-proxy", "qa-runner"]);
    expect(config.services["qa-runner"]?.environment).toMatchObject({ NO_PROXY: "localhost,127.0.0.1" });
  });

  test("render no proxy and no agent network for a runner without egress hosts, and keep the relay", async () => {
    const target = await loadTarget(ref, ledgerSource);
    const runDir = await scratch();
    const files = [join(ledgerSource, ".devcontainer", "compose.yml")];
    const bare = await normalize(runDir, files, renderOverride(spec(runDir, target, { egress: [] }), 1000, 1000));
    expect(Object.keys(bare.services).sort()).toEqual(["db", "qa-runner", "web"]);
    expect(Object.keys(bare.services["qa-runner"]?.networks ?? {})).toEqual(["qa_internal"]);
    expect([bare.networks.qa_agent, bare.networks.qa_egress]).toEqual([undefined, undefined]);

    const relayed: Target = { ...target, settings: { ...target.settings, egress: ["api.pwnedpasswords.com"] } };
    const config = await normalize(runDir, files, renderOverride(spec(runDir, relayed, { egress: [] }), 1000, 1000));
    expect(Object.keys(config.services).sort()).toEqual(["db", "qa-relay", "qa-runner", "web"]);
    expect(Object.keys(config.services["qa-runner"]?.networks ?? {})).toEqual(["qa_internal"]);
    expect(Object.keys(config.services["qa-relay"]?.networks ?? {}).sort()).toEqual(["qa_egress", "qa_relay"]);
    expect(config.networks.qa_agent).toBeUndefined();
    expect(config.networks.qa_egress).toMatchObject({ ipam: { config: [{ subnet: "10.213.7.128/25" }] } });
  });
});

describe.skipIf(!dockerAvailable)("environment helpers", () => {
  test("leave inactive services out of the image build", async () => {
    const target = await loadTarget(ref, ledgerSource);
    const profiled: Target = {
      ...target,
      services: { web: { build: true, image: null, tags: [], memLimit: null, networkMode: null, aliases: [], hasCpus: false, hasPidsLimit: false, deployLimits: false, active: false } },
    };
    expect((await buildImages("3f9a1c2e", profiled, ledgerSource)).images).toEqual({});
  });

  test("tag a built image only with the run's name and one shared name, whatever build tags the target sets", async () => {
    const source = await scratch();
    const runId = crypto.randomUUID().slice(0, 8);
    const scope = `qair-t-tags-${runId}/`;
    await Bun.write(join(source, "Dockerfile"), "FROM scratch\nCOPY Dockerfile /Dockerfile\n");
    await Bun.write(
      join(source, ".devcontainer", "devcontainer.json"),
      JSON.stringify({
        dockerComposeFile: "compose.yml",
        service: "web",
        customizations: { "qa-interns": { urls: { app: "http://web:3000" }, ready: "http://web:3000/health", seed: "node seed.mjs" } },
      }),
    );
    await Bun.write(
      join(source, ".devcontainer", "compose.yml"),
      `services:
  web:
    image: ${scope}web:latest
    build:
      context: ..
      tags: ["${scope}extra:latest"]
`,
    );
    const { images } = await buildImages(runId, await loadTarget(ref, source), source);
    const shared = await sharedTags(Object.values(images));
    const listed = (await execute(["docker", "image", "ls", "--format", "{{.Repository}}:{{.Tag}}"])).split("\n");
    const created = listed.filter((image) => [`qa-${runId}-`, scope].some((prefix) => image.startsWith(prefix)));
    if (created.length + shared.length > 0) await execute(["docker", "image", "rm", ...created, ...shared]);
    expect(images).toEqual({ web: `qa-${runId}-web:latest` });
    expect(created).toEqual([`qa-${runId}-web:latest`]);
    expect(shared).toHaveLength(1);
  });

  test("run a service without build that names a built service's image or build tag on the run's build of that service", async () => {
    const source = await scratch();
    const runId = crypto.randomUUID().slice(0, 8);
    const scope = `qair-t-shared-${runId}/`;
    await Bun.write(join(source, "Dockerfile"), "FROM scratch\nCOPY Dockerfile /Dockerfile\n");
    await Bun.write(
      join(source, ".devcontainer", "devcontainer.json"),
      JSON.stringify({
        dockerComposeFile: "compose.yml",
        service: "web",
        customizations: { "qa-interns": { urls: { app: "http://web:3000" }, ready: "http://web:3000/health", seed: "node seed.mjs" } },
      }),
    );
    await Bun.write(
      join(source, ".devcontainer", "compose.yml"),
      `services:
  web:
    build:
      context: ..
      tags: ["${scope}tagged:v1"]
    image: ${scope}app
  worker:
    image: ${scope}app:latest
  hub:
    image: docker.io/${scope}app
  tagged:
    image: ${scope}tagged:v1
  other:
    image: ${scope}app:v2
  tool:
    image: ${scope}app
    profiles: ["tools"]
  db:
    image: postgres:17-alpine
`,
    );
    const target = await loadTarget(ref, source);
    const { images } = await buildImages(runId, target, source);
    const run = `qa-${runId}-web:latest`;
    const shared = await sharedTags([run]);
    const listed = (await execute(["docker", "image", "ls", "--format", "{{.Repository}}:{{.Tag}}"])).split("\n");
    const created = listed.filter((image) => [`qa-${runId}-`, scope].some((prefix) => image.startsWith(prefix)));
    if (created.length + shared.length > 0) await execute(["docker", "image", "rm", ...created, ...shared]);
    expect(images).toEqual({ web: run, worker: run, hub: run, tagged: run });
    const runDir = await scratch();
    const config = await normalize(runDir, [join(source, ".devcontainer", "compose.yml")], renderOverride(spec(runDir, target, { images }), 1000, 1000));
    for (const name of ["worker", "hub", "tagged"]) expect(config.services[name]).toMatchObject({ image: run, pull_policy: "never" });
    expect(config.services.other?.image).toBe(`${scope}app:v2`);
    expect(config.services.other?.pull_policy).toBeUndefined();
  });

  test("reject a service without build whose image two built services produce, before building", async () => {
    const source = await scratch();
    const runId = crypto.randomUUID().slice(0, 8);
    const scope = `qair-t-twice-${runId}/`;
    await Bun.write(join(source, "Dockerfile"), "FROM scratch\nCOPY Dockerfile /Dockerfile\n");
    await Bun.write(
      join(source, ".devcontainer", "devcontainer.json"),
      JSON.stringify({
        dockerComposeFile: "compose.yml",
        service: "web",
        customizations: { "qa-interns": { urls: { app: "http://web:3000" }, ready: "http://web:3000/health", seed: "node seed.mjs" } },
      }),
    );
    await Bun.write(
      join(source, ".devcontainer", "compose.yml"),
      `services:
  web:
    build: ..
    image: ${scope}app
  api:
    build:
      context: ..
      tags: ["${scope}app:latest"]
  worker:
    image: ${scope}app
`,
    );
    const failure = await buildImages(runId, await loadTarget(ref, source), source).then(
      () => null,
      (error: unknown) => error,
    );
    const listed = (await execute(["docker", "image", "ls", "--format", "{{.Repository}}:{{.Tag}}"])).split("\n");
    const created = listed.filter((image) => [`qa-${runId}-`, scope].some((prefix) => image.startsWith(prefix)));
    if (created.length > 0) await execute(["docker", "image", "rm", ...created]);
    expect(String(failure)).toContain(`Services api and web both build the image ${scope}app that service worker runs`);
    expect(created).toEqual([]);
  });

  test("give a later run the image an earlier run built from an export with the same files and build settings, and build again when a file, a build argument, or a hostEnv value differs", async () => {
    const source = await scratch();
    const scope = crypto.randomUUID().slice(0, 8);
    await Bun.write(join(source, "Dockerfile"), "FROM scratch\nARG LABEL\nLABEL qa-interns-test=$LABEL\nCOPY build.txt /build.txt\n");
    await Bun.write(join(source, "build.txt"), scope);
    await Bun.write(
      join(source, ".devcontainer", "devcontainer.json"),
      JSON.stringify({
        dockerComposeFile: "compose.yml",
        service: "web",
        customizations: {
          "qa-interns": { urls: { app: "http://web:3000" }, ready: "http://web:3000/health", seed: "node seed.mjs", hostEnv: ["QA_INTERNS_TEST_LABEL", "QA_INTERNS_TEST_UNREAD"] },
        },
      }),
    );
    await Bun.write(
      join(source, ".devcontainer", "compose.yml"),
      "services:\n  web:\n    build:\n      context: ..\n      args:\n        LABEL: ${QA_INTERNS_TEST_LABEL}\n    env_file: initialized.env\n",
    );
    const own: string[] = [];
    const build = async (dir: string) => {
      const { images } = await buildImages(crypto.randomUUID().slice(0, 8), await loadTarget(ref, dir), dir);
      own.push(images.web ?? "");
      return images.web ?? "";
    };
    process.env.QA_INTERNS_TEST_LABEL = "one";
    process.env.QA_INTERNS_TEST_UNREAD = "one";
    try {
      const first = await build(source);
      const built = (await imageIds()).get(first);
      await execute(["docker", "image", "rm", first]);
      const copy = await scratch();
      await cp(source, copy, { recursive: true });
      const second = await build(copy);
      expect((await imageIds()).get(second)).toBe(built);
      process.env.QA_INTERNS_TEST_LABEL = "two";
      await build(copy);
      process.env.QA_INTERNS_TEST_LABEL = "one";
      process.env.QA_INTERNS_TEST_UNREAD = "two";
      await build(copy);
      process.env.QA_INTERNS_TEST_UNREAD = "one";
      await Bun.write(join(copy, "build.txt"), `${scope} changed`);
      await build(copy);
      expect(new Set(await sharedTags(own.slice(1))).size).toBe(4);
    } finally {
      delete process.env.QA_INTERNS_TEST_LABEL;
      delete process.env.QA_INTERNS_TEST_UNREAD;
      const ids = await imageIds();
      const left = [...new Set([...own, ...(await sharedTags(own))])].filter((name) => ids.has(name));
      if (left.length > 0) await execute(["docker", "image", "rm", ...left]);
    }
  });

  test("remove a shared image only when no run names it and the last run that used it released it 30 minutes ago, and keep each image that a run of another key names", async () => {
    const source = await scratch();
    const runId = crypto.randomUUID().slice(0, 8);
    const other = `qa-${crypto.randomUUID().slice(0, 8)}-api:latest`;
    await Bun.write(join(source, "Dockerfile"), "FROM scratch\nCOPY build.txt /build.txt\n");
    await Bun.write(join(source, "api.Dockerfile"), "FROM scratch\nCOPY build.txt /api.txt\n");
    await Bun.write(join(source, "build.txt"), runId);
    await Bun.write(
      join(source, ".devcontainer", "devcontainer.json"),
      JSON.stringify({
        dockerComposeFile: "compose.yml",
        service: "web",
        customizations: { "qa-interns": { urls: { app: "http://web:3000" }, ready: "http://web:3000/health", seed: "node seed.mjs" } },
      }),
    );
    await Bun.write(join(source, ".devcontainer", "compose.yml"), "services:\n  web:\n    build: ..\n  api:\n    build:\n      context: ..\n      dockerfile: api.Dockerfile\n");
    const { images, release } = await buildImages(runId, await loadTarget(ref, source), source);
    const own = [images.web ?? "", images.api ?? ""];
    const [web = "", api = ""] = await Promise.all(own.map(async (name) => (await sharedTags([name]))[0] ?? ""));
    const use = join(process.env.XDG_RUNTIME_DIR ?? "", "qa-interns", "images", web.slice("qa-build-".length).split("-")[0] ?? "");
    const released = async (minutes: number) => {
      const then = new Date(Date.now() - minutes * 60_000);
      await utimes(use, then, then);
    };
    const left = async () => {
      const ids = await imageIds();
      return [web, api].filter((name) => ids.has(name));
    };
    try {
      await released(31);
      await sweepImages();
      expect(await left()).toEqual([web, api]);
      await release();
      await released(29);
      await execute(["docker", "tag", api, other]);
      await execute(["docker", "image", "rm", ...own]);
      await sweepImages();
      expect(await left()).toEqual([web, api]);
      await released(31);
      await sweepImages();
      expect(await left()).toEqual([api]);
      await execute(["docker", "image", "rm", other]);
      await sweepImages();
      expect(await left()).toEqual([]);
    } finally {
      const ids = await imageIds();
      const names = [...own, other, web, api].filter((name) => ids.has(name));
      if (names.length > 0) await execute(["docker", "image", "rm", ...names]);
    }
  });

  test("route every environment host around the proxy", () => {
    const env = runnerEnv({ app: "http://web:3000", admin: "https://admin.shop.test:8443/login", api: "http://web:3000/api" });
    expect(env).toEqual({
      HOME: "/home/qa",
      HTTPS_PROXY: "http://qa-proxy:3128",
      HTTP_PROXY: "http://qa-proxy:3128",
      https_proxy: "http://qa-proxy:3128",
      http_proxy: "http://qa-proxy:3128",
      NO_PROXY: "web,admin.shop.test,localhost,127.0.0.1",
      no_proxy: "web,admin.shop.test,localhost,127.0.0.1",
      NODE_USE_ENV_PROXY: "1",
    });
  });

  test("bypass HSTS only for single-label hosts and treat every http origin as secure", async () => {
    const runDir = await scratch();
    await writeChromePolicy(runDir, {
      app: "http://app:3000",
      api: "http://app:3000/api",
      dev: "http://dev:5173",
      docs: "http://docs.shop.test",
      admin: "https://admin.shop.test",
    });
    expect(await Bun.file(join(runDir, "chrome-policy.json")).json()).toEqual({
      HSTSPolicyBypassList: ["app", "dev"],
      OverrideSecurityRestrictionsOnInsecureOrigin: ["http://app:3000", "http://dev:5173", "http://docs.shop.test"],
    });
  });

  test(
    "remove a directory that holds a mounted output disk under a space and a symbolic link, and leave no mount behind",
    async () => {
      const root = await scratch();
      await mkdir(join(root, "real dir"));
      await symlink(join(root, "real dir"), join(root, "linked dir"));
      const dir = join(root, "linked dir", "run");
      const image = await ensureRunnerImage();
      const out = join(dir, "interns", "i1", "out");
      await mkdir(out, { recursive: true });
      await createDisk(out, image, "qair-t-remove");
      await Bun.write(join(out, "left.txt"), "left\n");
      await removeDir(dir, image, "qair-t-remove");
      expect(existsSync(join(root, "real dir", "run"))).toBe(false);
      expect(readFileSync("/proc/self/mountinfo", "utf8")).not.toContain(root);
    },
    20 * 60_000,
  );

  test(
    "a save of an output disk that a process holds fails and keeps the disk's files readable, and a later save copies them into the folder",
    async () => {
      const root = await scratch();
      const image = await ensureRunnerImage();
      const out = join(root, "interns", "i1", "out");
      await mkdir(out, { recursive: true });
      await createDisk(out, image, "qair-t-busy");
      await mkdir(join(out, "findings"));
      await Bun.write(join(out, "findings", "a.json"), "{}\n");
      const mounted = () => readFileSync("/proc/self/mountinfo", "utf8").includes(` ${out} `);
      const holder = Bun.spawn(["sleep", "infinity"], { cwd: out });
      try {
        await expect(saveDisk(out, image, "qair-t-busy")).rejects.toThrow(`exited with 32: umount: ${out}: target is busy.`);
        expect(mounted()).toBe(true);
        expect(await Bun.file(join(out, "findings", "a.json")).text()).toBe("{}\n");
      } finally {
        holder.kill();
        await holder.exited;
      }
      await saveDisk(out, image, "qair-t-busy");
      expect(mounted()).toBe(false);
      expect(await readdir(dirname(out))).toEqual(["out"]);
      expect(await Bun.file(join(out, "findings", "a.json")).text()).toBe("{}\n");
    },
    20 * 60_000,
  );
});

describe.skipIf(!dockerAvailable)("startEnvironment", () => {
  test(
    "save the output disk of an environment that only down tears down",
    async () => {
      const runId = crypto.randomUUID().slice(0, 8);
      const runDir = await scratch();
      const image = await ensureRunnerImage();
      await writeChromePolicy(runDir, {});
      const out = join(runDir, "interns", "i1", "out");
      const runner = { image, out, env: runnerEnv({}), mounts: [], files: [], tmpfs: [] };
      try {
        const environment = await startEnvironment(spec(runDir, null, { runId, slot: await takeSlot(), runner }));
        await execute(["docker", "exec", environment.runner, "sh", "-c", "mkdir /qa/out/findings && echo '{}' > /qa/out/findings/left.json"]);
      } finally {
        await stopRun(runDir, runId);
        await removeCopies(runDir, runId, image);
      }
      expect(await Bun.file(join(out, "findings", "left.json")).text()).toBe("{}\n");
      expect(existsSync(`${out}.img`)).toBe(false);
      expect((await stat(out)).dev).toBe((await stat(dirname(out))).dev);
    },
    20 * 60_000,
  );

  test(
    "hand the target only the host variables that hostEnv names",
    async () => {
      const runId = crypto.randomUUID().slice(0, 8);
      const runDir = await scratch();
      const source = join(runDir, "source");
      await Bun.write(join(source, "Dockerfile"), "FROM busybox:1.37\nARG BUILD_LISTED\nARG BUILD_UNLISTED\nENV BUILT_LISTED=$BUILD_LISTED BUILT_UNLISTED=$BUILD_UNLISTED\n");
      await Bun.write(
        join(source, ".devcontainer", "compose.yml"),
        `services:
  web:
    build:
      context: ..
      args:
        BUILD_LISTED: \${QA_INTERNS_TEST_LISTED}
        BUILD_UNLISTED: \${QA_INTERNS_TEST_UNLISTED}
    command: ["sleep", "86400"]
    init: true
    environment:
      - QA_INTERNS_TEST_LISTED
      - QA_INTERNS_TEST_UNLISTED
      - INTERPOLATED_LISTED=\${QA_INTERNS_TEST_LISTED}/api
      - INTERPOLATED_UNLISTED=\${QA_INTERNS_TEST_UNLISTED}/api
`,
      );
      const seed = `printf '{"environment":["%s","%s"],"interpolation":["%s","%s"],"build":["%s","%s"],"containerEnv":["%s","%s"],"remoteEnv":["%s","%s"]}' "$QA_INTERNS_TEST_LISTED" "$QA_INTERNS_TEST_UNLISTED" "$INTERPOLATED_LISTED" "$INTERPOLATED_UNLISTED" "$BUILT_LISTED" "$BUILT_UNLISTED" "$LOCAL_LISTED" "$LOCAL_UNLISTED" "$REMOTE_LISTED" "$REMOTE_UNLISTED"`;
      await Bun.write(
        join(source, ".devcontainer", "devcontainer.json"),
        JSON.stringify({
          dockerComposeFile: "compose.yml",
          service: "web",
          containerEnv: { LOCAL_LISTED: "${localEnv:QA_INTERNS_TEST_LISTED}", LOCAL_UNLISTED: "${localEnv:QA_INTERNS_TEST_UNLISTED}" },
          remoteEnv: { REMOTE_LISTED: "${localEnv:QA_INTERNS_TEST_LISTED}", REMOTE_UNLISTED: "${localEnv:QA_INTERNS_TEST_UNLISTED}" },
          customizations: { "qa-interns": { urls: { app: "http://web:8080" }, ready: "true", seed, hostEnv: ["QA_INTERNS_TEST_LISTED"] } },
        }),
      );
      const image = await ensureRunnerImage();
      process.env.QA_INTERNS_TEST_LISTED = "listed";
      process.env.QA_INTERNS_TEST_UNLISTED = "unlisted";
      try {
        const target = await loadTarget(ref, source);
        const { images } = await buildImages(runId, target, source);
        await writeChromePolicy(runDir, target.settings.urls);
        const runner = { image, out: join(runDir, "interns", "i1", "out"), env: runnerEnv(target.settings.urls), mounts: [], files: [], tmpfs: [] };
        const environment = await startEnvironment(spec(runDir, target, { runId, slot: await takeSlot(), images, runner }));
        expect(environment.seed).toEqual({
          environment: ["listed", ""],
          interpolation: ["listed/api", "/api"],
          build: ["listed", ""],
          containerEnv: ["listed", ""],
          remoteEnv: ["listed", ""],
        });
      } finally {
        delete process.env.QA_INTERNS_TEST_LISTED;
        delete process.env.QA_INTERNS_TEST_UNLISTED;
        await stopRun(runDir, runId);
        await removeCopies(runDir, runId, image);
      }
    },
    20 * 60_000,
  );

  test(
    "keep the secret values of a seed that prints its output and then fails, before its error quotes them",
    async () => {
      const runId = crypto.randomUUID().slice(0, 8);
      const runDir = await scratch();
      const source = join(runDir, "source");
      const key = `sk_seed_${runId}`;
      await Bun.write(join(source, ".devcontainer", "compose.yml"), 'services:\n  web:\n    image: busybox:1.37\n    command: ["sleep", "86400"]\n    init: true\n');
      const seed = `echo '{"apiKey":"${key}"}'; echo 'seeding failed after ${key}' >&2; exit 1`;
      const settings = { urls: { app: "http://web:8080" }, ready: "true", seed, secrets: { seed: ["apiKey"] } };
      await Bun.write(join(source, ".devcontainer", "devcontainer.json"), JSON.stringify({ dockerComposeFile: "compose.yml", service: "web", customizations: { "qa-interns": settings } }));
      const image = await ensureRunnerImage();
      try {
        const target = await loadTarget(ref, source);
        await writeChromePolicy(runDir, target.settings.urls);
        const runner = { image, out: join(runDir, "interns", "i1", "out"), env: runnerEnv(target.settings.urls), mounts: [], files: [], tmpfs: [] };
        const failed = await startEnvironment(spec(runDir, target, { runId, slot: await takeSlot(), runner })).then(
          () => null,
          (error: unknown) => error,
        );
        expect(failed).toBeInstanceOf(Error);
        expect(String(failed)).toContain(" exited with 1: ");
        expect(String(failed)).toEndWith("\nseeding failed after [redacted]");
        expect(redact(key)).toBe("[redacted]");
      } finally {
        forgetSecrets();
        await stopRun(runDir, runId);
        await removeCopies(runDir, runId, image);
      }
    },
    20 * 60_000,
  );

  test(
    "keep the proxies of the Docker client configuration, under any key spelling Docker reads, out of every container and image build",
    async () => {
      const runId = `btest-${crypto.randomUUID().slice(0, 8)}`;
      const runDir = await scratch();
      const source = join(runDir, "source");
      const dockerConfig = join(runDir, "docker");
      await Bun.write(
        join(dockerConfig, "config.json"),
        JSON.stringify({
          proxies: { default: { httpProxy: "http://qa:secret@corp-proxy.test:3128" } },
          Proxieſ: { default: { allProxy: "socks5://qa:secret@corp-proxy.test:1080" } },
        }),
      );
      await Bun.write(join(source, "Dockerfile"), `FROM busybox:1.37\nRUN printf %s "$HTTP_PROXY$ALL_PROXY" > /build-proxy-${runId}\n`);
      await Bun.write(join(source, ".devcontainer", "compose.yml"), 'services:\n  web:\n    build: ..\n    command: ["sleep", "86400"]\n    init: true\n');
      await Bun.write(
        join(source, ".devcontainer", "devcontainer.json"),
        JSON.stringify({
          dockerComposeFile: "compose.yml",
          service: "web",
          customizations: { "qa-interns": { urls: { app: "http://web:8080" }, ready: "true", seed: `printf '{"build":"%s"}' "$(cat /build-proxy-${runId})"` } },
        }),
      );
      const image = await ensureRunnerImage();
      const hostConfig = process.env.DOCKER_CONFIG;
      process.env.DOCKER_CONFIG = dockerConfig;
      let shared: string[] = [];
      try {
        const target = await loadTarget(ref, source);
        const { images } = await buildImages(runId, target, source);
        shared = await sharedTags(Object.values(images));
        await writeChromePolicy(runDir, target.settings.urls);
        const runner = (name: string, urls: Record<string, string>) => ({ image, out: join(runDir, "interns", name, "out"), env: runnerEnv(urls), mounts: [], files: [], tmpfs: [] });
        const intern = await startEnvironment(spec(runDir, target, { runId, slot: await takeSlot(), images, runner: runner("i1", target.settings.urls) }));
        const judge = await startEnvironment(spec(runDir, null, { runId, name: "judge", slot: await takeSlot(), runner: runner("judge", {}) }));
        const containers = [intern.project, judge.project].flatMap((project) => {
          const ids = Bun.spawnSync(["docker", "ps", "-aq", "--filter", `label=com.docker.compose.project=${project}`]).stdout.toString().split("\n").filter((id) => id !== "");
          const inspected = JSON.parse(Bun.spawnSync(["docker", "inspect", ...ids]).stdout.toString());
          return z.array(z.object({ Config: z.object({ Labels: z.record(z.string(), z.string()), Env: z.array(z.string()) }) })).parse(inspected);
        });
        expect(containers.map(({ Config }) => `${Config.Labels["com.docker.compose.project"]}/${Config.Labels["com.docker.compose.service"]}`).sort()).toEqual(
          [`${intern.project}/qa-proxy`, `${intern.project}/qa-runner`, `${intern.project}/web`, `${judge.project}/qa-proxy`, `${judge.project}/qa-runner`].sort(),
        );
        expect(containers.flatMap(({ Config }) => Config.Env.filter((entry) => entry.includes("corp-proxy.test")))).toEqual([]);
        expect(intern.seed).toEqual({ build: "" });
      } finally {
        if (hostConfig === undefined) delete process.env.DOCKER_CONFIG;
        else process.env.DOCKER_CONFIG = hostConfig;
        await stopRun(runDir, runId);
        await removeCopies(runDir, runId, image);
        if (shared.length > 0) await execute(["docker", "image", "rm", ...shared]);
      }
    },
    20 * 60_000,
  );

  test(
    "leave a target container that stops after the environment starts stopped, so Docker never resolves its bind sources again",
    async () => {
      const runId = crypto.randomUUID().slice(0, 8);
      const runDir = await scratch();
      const source = join(runDir, "source");
      const host = join(runDir, "host");
      await Bun.write(join(host, "marker"), "host only\n");
      await mkdir(join(source, "uploads"), { recursive: true });
      await Bun.write(
        join(source, ".devcontainer", "compose.yml"),
        `services:
  web:
    image: busybox:1.37
    restart: always
    command: ["sh", "-c", "until [ -e /app/stop ]; do sleep 1; done; rm /app/stop"]
    volumes: ["..:/app", "../uploads:/uploads"]
`,
      );
      await Bun.write(
        join(source, ".devcontainer", "devcontainer.json"),
        JSON.stringify({ dockerComposeFile: "compose.yml", service: "web", customizations: { "qa-interns": { urls: { app: "http://web:8080" }, ready: "true", seed: "echo {}" } } }),
      );
      const image = await ensureRunnerImage();
      try {
        const target = await loadTarget(ref, source);
        await writeChromePolicy(runDir, target.settings.urls);
        const runner = { image, out: join(runDir, "interns", "i1", "out"), env: runnerEnv(target.settings.urls), mounts: [], files: [], tmpfs: [] };
        const environment = await startEnvironment(spec(runDir, target, { runId, slot: await takeSlot(), runner }));
        const web = (await execute(["docker", "compose", "-p", environment.project, "ps", "-q", "web"])).trim();
        await execute(["docker", "exec", web, "sh", "-c", `rmdir /app/uploads && ln -s ${host} /app/uploads && touch /app/stop`]);
        await execute(["docker", "wait", web]);
        expect((await execute(["docker", "inspect", "--format", "{{.State.Status}} {{.RestartCount}}", web])).trim()).toBe("exited 0");
      } finally {
        await stopRun(runDir, runId);
        await removeCopies(runDir, runId, image);
      }
    },
    20 * 60_000,
  );

  test(
    "read each container's state, peak memory, out-of-memory kill, and restarts after the ready check passed",
    async () => {
      const runId = `btest-${crypto.randomUUID().slice(0, 8)}`;
      const runDir = await scratch();
      const source = join(runDir, "source");
      const service = (command: string, extra = "") => `    image: busybox:1.37\n    init: true\n    command: ["sh", "-c", ${JSON.stringify(command)}]\n${extra}`;
      await Bun.write(
        join(source, ".devcontainer", "compose.yml"),
        `services:
  web:
${service("exec sleep 86400")}  hog:
${service("tail /dev/zero; exec sleep 86400", "    mem_limit: 32m\n")}  worker:
${service("until [ -e /tmp/stop ]; do sleep 1; done")}  flaky:
${service("[ -e /tmp/once ] || { touch /tmp/once; exit 1; }; exec sleep 86400", "    restart: on-failure\n")}`,
      );
      await Bun.write(
        join(source, ".devcontainer", "devcontainer.json"),
        JSON.stringify({ dockerComposeFile: "compose.yml", service: "web", customizations: { "qa-interns": { urls: { app: "http://web:8080" }, ready: "true", seed: "echo {}" } } }),
      );
      const image = await ensureRunnerImage();
      try {
        const target = await loadTarget(ref, source);
        await writeChromePolicy(runDir, target.settings.urls);
        const runner = { image, out: join(runDir, "interns", "i1", "out"), env: runnerEnv(target.settings.urls), mounts: [], files: [], tmpfs: [] };
        let ready = false;
        const environment = await startEnvironment(spec(runDir, target, { runId, slot: await takeSlot(), runner }), () => {
          ready = true;
        });
        expect(ready).toBe(true);
        const worker = (await execute(["docker", "compose", "-p", environment.project, "ps", "-q", "worker"])).trim();
        await execute(["docker", "exec", worker, "touch", "/tmp/stop"]);
        await execute(["docker", "wait", worker]);

        const stats = await containerStats(environment.project);
        await stopEnvironment(runDir, "i1", environment.project, image);
        expect(stats.map(({ memoryPeak, ...rest }) => rest)).toEqual([
          { service: "flaky", number: 1, state: "running", oomKilled: false, restarts: 1 },
          { service: "hog", number: 1, state: "running", oomKilled: true, restarts: 0 },
          { service: "qa-proxy", number: 1, state: "running", oomKilled: false, restarts: 0 },
          { service: "qa-runner", number: 1, state: "running", oomKilled: false, restarts: 0 },
          { service: "web", number: 1, state: "running", oomKilled: false, restarts: 0 },
          { service: "worker", number: 1, state: "exited", oomKilled: false, restarts: 0 },
        ]);
        const peaks = Object.fromEntries(stats.map((entry) => [entry.service, entry.memoryPeak]));
        expect(peaks.hog).toBeGreaterThanOrEqual(32 * 1024 ** 2);
        expect(peaks.worker).toBeNull();
        for (const name of ["flaky", "qa-proxy", "qa-runner", "web"]) expect(peaks[name]).toBeGreaterThan(0);
        expect((await execute(["docker", "ps", "-aq", "--filter", `label=com.docker.compose.project=${environment.project}`])).trim()).toBe("");
      } finally {
        await stopRun(runDir, runId);
        await removeCopies(runDir, runId, image);
      }
    },
    20 * 60_000,
  );

  test(
    "keep two log files of 10 MB for the runner and for the proxy, whatever a process in the runner writes",
    async () => {
      const file = 10_000_000;
      const runId = `btest-${crypto.randomUUID().slice(0, 8)}`;
      const runDir = await scratch();
      const image = await ensureRunnerImage();
      await writeChromePolicy(runDir, {});
      const runner = { image, out: join(runDir, "interns", "i1", "out"), env: runnerEnv({}), mounts: [], files: [], tmpfs: [] };
      const flood = [
        "const { writeFileSync } = require('node:fs');",
        "const { connect } = require('node:net');",
        "const pad = 'x'.repeat(8000);",
        "writeFileSync('/proc/1/fd/1', `${pad}\\n`.repeat(8192));",
        "const batch = `GET http://x/${pad} HTTP/1.1\\r\\nHost: x\\r\\n\\r\\n`.repeat(128);",
        "(async () => {",
        "  for (let i = 0; i < 64; i++) await new Promise((resolve, reject) => connect(3128, 'qa-proxy').on('close', resolve).on('error', reject).resume().end(batch));",
        "})();",
      ].join("\n");
      try {
        const environment = await startEnvironment(spec(runDir, null, { runId, slot: await takeSlot(), runner }));
        const proxy = (await execute(["docker", "compose", "-p", environment.project, "ps", "-q", "qa-proxy"])).trim();
        await execute(["docker", "exec", environment.runner, "node", "-e", flood]);
        for (const container of [environment.runner, proxy]) {
          const kept = (await execute(["docker", "logs", container])).length;
          expect(kept).toBeGreaterThan(file);
          expect(kept).toBeLessThanOrEqual(2 * file);
        }
      } finally {
        await stopRun(runDir, runId);
        await removeCopies(runDir, runId, image);
      }
    },
    5 * 60_000,
  );

  test(
    "keep two log files of 10 MB for each Ledger service, whatever the service writes",
    async () => {
      const file = 10_000_000;
      const runId = `btest-${crypto.randomUUID().slice(0, 8)}`;
      const runDir = await scratch();
      const source = join(runDir, "source");
      await cp(ledgerSource, source, { recursive: true, filter: (path) => basename(path) !== "node_modules" });
      const image = await ensureRunnerImage();
      const flood = 'yes "$(head -c 8000 /dev/zero | tr "\\0" x)" | head -c 67108864 > /proc/1/fd/1';
      try {
        const target = await loadTarget(ref, source);
        const { images } = await buildImages(runId, target, source);
        await writeChromePolicy(runDir, target.settings.urls);
        const runner = { image, out: join(runDir, "interns", "i1", "out"), env: runnerEnv(target.settings.urls), mounts: [], files: [], tmpfs: [] };
        const environment = await startEnvironment(spec(runDir, target, { runId, slot: await takeSlot(), images, runner }));
        expect(Object.keys(target.services).sort()).toEqual(["db", "web"]);
        for (const service of Object.keys(target.services)) {
          const container = (await execute(["docker", "compose", "-p", environment.project, "ps", "-q", service])).trim();
          await execute(["docker", "exec", "--privileged", "--user", "0", container, "sh", "-c", flood]);
          const logs = await capture(["docker", "logs", container]);
          expect(logs.code).toBe(0);
          const kept = logs.stdout.length + logs.stderr.length;
          expect(kept).toBeGreaterThan(file);
          expect(kept).toBeLessThanOrEqual(2 * file);
        }
      } finally {
        await stopRun(runDir, runId);
        await removeCopies(runDir, runId, image);
      }
    },
    20 * 60_000,
  );

  test.each([
    ["an empty runServices", [], ["extra", "web"]],
    ["a runServices entry whose profile enables an optional dependency", ["worker"], ["helper", "web", "worker"]],
  ])(
    "start exactly the services that loadTarget counts as active for %s",
    async (_, runServices, expected) => {
      const runId = `btest-${crypto.randomUUID().slice(0, 8)}`;
      const runDir = await scratch();
      const source = join(runDir, "source");
      const sleeper = `    image: busybox:1.37\n    command: ["sleep", "86400"]\n    init: true\n`;
      await Bun.write(
        join(source, ".devcontainer", "compose.yml"),
        `services:
  web:
${sleeper}  extra:
${sleeper}  worker:
${sleeper}    profiles: ["jobs"]
    depends_on:
      helper:
        condition: service_started
        required: false
  helper:
${sleeper}    profiles: ["jobs"]
  mailer:
${sleeper}    profiles: ["mail"]
`,
      );
      await Bun.write(
        join(source, ".devcontainer", "devcontainer.json"),
        JSON.stringify({
          dockerComposeFile: "compose.yml",
          service: "web",
          runServices,
          customizations: { "qa-interns": { urls: { app: "http://web:8080" }, ready: "true", seed: "echo '{}'" } },
        }),
      );
      const image = await ensureRunnerImage();
      try {
        const target = await loadTarget(ref, source);
        expect(Object.keys(target.services).filter((name) => target.services[name]?.active).sort()).toEqual(expected);
        const { images } = await buildImages(runId, target, source);
        await writeChromePolicy(runDir, target.settings.urls);
        const runner = { image, out: join(runDir, "interns", "i1", "out"), env: runnerEnv(target.settings.urls), mounts: [], files: [], tmpfs: [] };
        const environment = await startEnvironment(spec(runDir, target, { runId, slot: await takeSlot(), images, runner }));
        const running = (await execute(["docker", "compose", "-p", environment.project, "ps", "--services"])).split("\n").filter((name) => name !== "");
        expect(running.sort()).toEqual([...expected, "qa-proxy", "qa-runner"].sort());
      } finally {
        await stopRun(runDir, runId);
        await removeCopies(runDir, runId, image);
      }
    },
    20 * 60_000,
  );
});

function u16(value: number): Buffer {
  const buffer = Buffer.alloc(2);
  buffer.writeUInt16BE(value);
  return buffer;
}

function clientHello(name: Buffer): Buffer {
  const entry = Buffer.concat([Buffer.from([0]), u16(name.length), name]);
  const extension = Buffer.concat([u16(0), u16(entry.length + 2), u16(entry.length), entry]);
  const body = Buffer.concat([Buffer.from([3, 3]), Buffer.alloc(32), Buffer.from([0]), u16(2), Buffer.from([0x13, 0x01]), Buffer.from([1, 0]), u16(extension.length), extension]);
  const handshake = Buffer.concat([Buffer.from([1, body.length >> 16, (body.length >> 8) & 255, body.length & 255]), body]);
  return Buffer.concat([Buffer.from([22, 3, 1]), u16(handshake.length), handshake]);
}

async function labelOverride(runDir: string): Promise<string> {
  const file = join(runDir, "compose.label.yml");
  const labels = [suiteLabel];
  await Bun.write(
    file,
    JSON.stringify({
      services: { app: { labels }, upstream: { labels }, "qa-relay": { labels } },
      networks: { qa_internal: { labels }, qa_relay: { labels }, qa_egress: { labels } },
    }),
  );
  return file;
}

describe.skipIf(!dockerAvailable)("qa-relay", () => {
  test(
    "carry HTTPS from a target service to its egress hosts and to no other host, and record each connection's outcome through teardown",
    async () => {
      const image = await ensureRunnerImage();
      const source = await scratch();
      const certs = join(source, "certs");
      await mkdir(certs);
      await execute([
        "docker", "run", "--rm", "--network", "none", "-v", `${certs}:/certs`, image,
        "openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=api.example.test",
        "-addext", "subjectAltName=DNS:api.example.test,DNS:blocked.example.test", "-keyout", "/certs/key.pem", "-out", "/certs/cert.pem",
      ]);
      await Bun.write(
        join(source, ".devcontainer", "devcontainer.json"),
        JSON.stringify({
          dockerComposeFile: "compose.yml",
          service: "app",
          customizations: { "qa-interns": { urls: { app: "http://app:3000" }, ready: "true", seed: "true", egress: ["api.example.test", "gone.example.test"] } },
        }),
      );
      const onStop = 'process.on("SIGTERM", () => require("node:net").connect(443, "api.example.test", function () { this.write("GET / HTTP/1.1\\r\\n\\r\\n"); }).on("close", () => process.exit(0))); setInterval(() => {}, 60000)';
      await Bun.write(join(source, ".devcontainer", "compose.yml"), JSON.stringify({ services: { app: { image, command: ["node", "-e", onStop], volumes: ["../certs:/certs:ro"] } } }));
      const target = await loadTarget(ref, source);
      const runDir = await scratch();
      const slot = await takeSlot();
      const base = spec(runDir, target, { slot });
      const override = join(runDir, "compose.qa.yml");
      await Bun.write(override, renderOverride({ ...base, runner: { ...base.runner, image } }, 1000, 1000));
      const server = 'require("node:https").createServer({ key: require("node:fs").readFileSync("/certs/key.pem"), cert: require("node:fs").readFileSync("/certs/cert.pem") }, (req, res) => res.end("upstream " + req.headers.host)).listen(443)';
      const upstream = join(runDir, "upstream.yml");
      await Bun.write(
        upstream,
        JSON.stringify({ services: { upstream: { image, command: ["node", "-e", server], volumes: [`${certs}:/certs:ro`], networks: { qa_egress: { aliases: ["api.example.test", "blocked.example.test"] } } } } }),
      );
      const project = `qair-relay-${crypto.randomUUID().slice(0, 8)}`;
      const compose = ["docker", "compose", "-p", project, "-f", join(source, ".devcontainer", "compose.yml"), "-f", override, "-f", upstream, "-f", await labelOverride(runDir)];
      const saved = join(runDir, "interns", "i1");
      try {
        await execute([...compose, "up", "-d", "--wait", "app", "upstream", "qa-relay"]);
        const curl = [...compose, "exec", "-T", "app", "curl", "-sS", "--max-time", "10", "--cacert", "/certs/cert.pem"];
        expect(await execute([...curl, "--retry", "10", "--retry-all-errors", "--retry-delay", "1", "https://api.example.test/"])).toBe("upstream api.example.test");
        const blocked = await capture([...curl, "--resolve", `blocked.example.test:443:10.213.${slot * 2}.254`, "https://blocked.example.test/"]);
        expect(blocked.code).not.toBe(0);
        const plain = await capture([...curl, "http://api.example.test:443/"]);
        expect(plain.code).not.toBe(0);
        expect(plain.code).not.toBe(28);
        expect((await capture([...curl, "https://blocked.example.test/"])).code).toBe(6);
        await execute([...compose, "exec", "-T", "app", "node", "-e", "require('node:net').connect(443, 'api.example.test').on('connect', function () { this.end(); })"]);
        expect((await capture([...curl, "https://gone.example.test/"])).code).not.toBe(0);
        const hello = clientHello(Buffer.alloc(30_000, 1)).toString("hex");
        await execute([...compose, "exec", "-T", "app", "node", "-e", "require('node:net').connect(443, 'api.example.test', function () { this.end(Buffer.from(process.argv[1], 'hex')); })", hello]);
      } finally {
        await stopProject(project, saved);
      }
      const [records = [], ...others] = await readRelayLogs(saved);
      expect(others).toEqual([]);
      expect(records.map((entry) => entry.n)).toEqual(records.map((_, index) => index + 1));
      const retries = (entry: RelayRecord) => entry.host === "api.example.test" && entry.outcome === "failed";
      expect(records.filter((entry) => !retries(entry)).map((entry) => [entry.host, entry.outcome, entry.error])).toEqual([
        ["api.example.test", "connected", null],
        ["blocked.example.test", "denied", null],
        [null, "denied", null],
        [null, "incomplete", null],
        ["gone.example.test", "failed", "ENOTFOUND"],
        ["\u0001".repeat(253), "denied", null],
        [null, "denied", null],
      ]);
      const [file = ""] = (await readdir(saved)).filter((name) => name.startsWith("relay-"));
      const lines = (await Bun.file(join(saved, file)).text()).split("\n");
      expect(Math.max(...lines.map((line) => Buffer.byteLength(line) + 1))).toBeLessThanOrEqual(4096);
    },
    20 * 60_000,
  );

  test(
    "refuse a connection past a connection limit of its egress host and record the limit",
    async () => {
      const image = await ensureRunnerImage();
      const source = await scratch();
      const certs = join(source, "certs");
      await mkdir(certs);
      await execute([
        "docker", "run", "--rm", "--network", "none", "-v", `${certs}:/certs`, image,
        "openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=limited.example.test",
        "-addext", "subjectAltName=DNS:limited.example.test,DNS:rate.example.test", "-keyout", "/certs/key.pem", "-out", "/certs/cert.pem",
      ]);
      const connectionLimits = { "limited.example.test": { concurrent: 1, total: 3 }, "rate.example.test": { perMinute: 2 } };
      await Bun.write(
        join(source, ".devcontainer", "devcontainer.json"),
        JSON.stringify({
          dockerComposeFile: "compose.yml",
          service: "app",
          customizations: { "qa-interns": { urls: { app: "http://app:3000" }, ready: "true", seed: "true", egress: ["limited.example.test", "rate.example.test"], connectionLimits } },
        }),
      );
      await Bun.write(join(source, ".devcontainer", "compose.yml"), JSON.stringify({ services: { app: { image, volumes: ["../certs:/certs:ro"] } } }));
      const target = await loadTarget(ref, source);
      const runDir = await scratch();
      const base = spec(runDir, target, { slot: await takeSlot() });
      const override = join(runDir, "compose.qa.yml");
      await Bun.write(override, renderOverride({ ...base, runner: { ...base.runner, image } }, 1000, 1000));
      const server = 'require("node:https").createServer({ key: require("node:fs").readFileSync("/certs/key.pem"), cert: require("node:fs").readFileSync("/certs/cert.pem") }, (req, res) => res.end("upstream")).listen(443)';
      const upstream = join(runDir, "upstream.yml");
      await Bun.write(
        upstream,
        JSON.stringify({ services: { upstream: { image, command: ["node", "-e", server], volumes: [`${certs}:/certs:ro`], networks: { qa_egress: { aliases: ["limited.example.test", "rate.example.test"] } } } } }),
      );
      const project = `qair-relay-${crypto.randomUUID().slice(0, 8)}`;
      const compose = ["docker", "compose", "-p", project, "-f", join(source, ".devcontainer", "compose.yml"), "-f", override, "-f", upstream, "-f", await labelOverride(runDir)];
      const saved = join(runDir, "interns", "i1");
      const probe = `
const tls = require("node:tls");
const ca = require("node:fs").readFileSync("/certs/cert.pem");
const open = (host) => new Promise((resolve) => {
  const socket = tls.connect({ host, port: 443, servername: host, ca });
  socket.once("secureConnect", () => resolve(socket));
  socket.once("error", () => resolve(null));
  socket.once("close", () => resolve(null));
});
const close = (socket) => { socket.destroy(); return new Promise((resolve) => setTimeout(resolve, 1000)); };
(async () => {
  const opened = [];
  const first = await open("limited.example.test");
  opened.push(first !== null, (await open("limited.example.test")) !== null);
  await close(first);
  for (const host of ["limited.example.test", "limited.example.test", "limited.example.test", "rate.example.test", "rate.example.test", "rate.example.test"]) {
    const socket = await open(host);
    opened.push(socket !== null);
    if (socket !== null) await close(socket);
  }
  console.log(JSON.stringify(opened));
})();
`;
      try {
        await execute([...compose, "up", "-d", "--wait", "app", "upstream", "qa-relay"]);
        expect(JSON.parse(await execute([...compose, "exec", "-T", "app", "node", "-e", probe]))).toEqual([true, false, true, true, false, true, true, false]);
      } finally {
        await stopProject(project, saved);
      }
      const [records = [], ...others] = await readRelayLogs(saved);
      expect(others).toEqual([]);
      expect(records.map((entry) => [entry.n, entry.host, entry.outcome, entry.error])).toEqual([
        [1, "limited.example.test", "connected", null],
        [2, "limited.example.test", "refused", "concurrent"],
        [3, "limited.example.test", "connected", null],
        [4, "limited.example.test", "connected", null],
        [5, "limited.example.test", "refused", "total"],
        [6, "rate.example.test", "connected", null],
        [7, "rate.example.test", "connected", null],
        [8, "rate.example.test", "refused", "perMinute"],
      ]);
    },
    20 * 60_000,
  );
});
