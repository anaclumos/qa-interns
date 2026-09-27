import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { buildImages, environmentMemory, freeSlot, freeSlots, renderOverride, runnerEnv, slotSubnets, writeChromePolicy, type EnvironmentSpec } from "../src/environment.ts";
import { loadTarget, type Target } from "../src/target.ts";

const dockerAvailable = Bun.spawnSync(["docker", "info"], { stdout: "ignore", stderr: "ignore" }).exitCode === 0;

const ledgerSource = join(import.meta.dir, "..", "eval", "ledger");
const ref = { repo: "/home/dev/ledger", path: "", commit: "4f1c2a9e0b7d3c5a8e6f1d2b9c0a7e3f5d8b1c4a" };
const roots: string[] = [];

afterAll(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true });
});

async function scratch(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "qa-interns-env-"));
  roots.push(root);
  return root;
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

async function normalize(runDir: string, composeFiles: string[], override: string): Promise<Normalized> {
  const file = join(runDir, "compose.qa.yml");
  await Bun.write(file, override);
  const args = [...composeFiles, file].flatMap((path) => ["-f", path]);
  const proc = Bun.spawnSync(["docker", "compose", "-p", "qa-render-check", ...args, "config", "--format", "json"], { stderr: "pipe" });
  if (proc.exitCode !== 0) throw new Error(proc.stderr.toString());
  return JSON.parse(proc.stdout.toString());
}

describe.skipIf(!dockerAvailable)("slots", () => {
  test("map a slot to its internal, agent, and egress subnets", () => {
    expect(slotSubnets(0)).toEqual({ internal: "10.213.0.0/25", agent: "10.213.0.128/25", egress: "10.213.1.0/24" });
    expect(slotSubnets(3)).toEqual({ internal: "10.213.6.0/25", agent: "10.213.6.128/25", egress: "10.213.7.0/24" });
    expect(slotSubnets(127)).toEqual({ internal: "10.213.254.0/25", agent: "10.213.254.128/25", egress: "10.213.255.0/24" });
  });

  test.each([-1, 128, 1.5])("reject slot %p", (slot) => {
    expect(() => slotSubnets(slot)).toThrow("is not an integer from 0 to 127");
  });

  test("reserve the slot it returns, so concurrent callers get different slots", async () => {
    const reserved = new Set<number>([0]);
    const slots = await Promise.all([freeSlot(reserved), freeSlot(reserved), freeSlot(reserved)]);
    expect(new Set(slots).size).toBe(3);
    expect(slots).not.toContain(0);
    for (const slot of slots) expect(reserved.has(slot)).toBe(true);
  });

  async function withNetwork(subnet: string, check: () => Promise<void>): Promise<void> {
    const name = `qa-btest-${crypto.randomUUID().slice(0, 8)}`;
    const proc = Bun.spawnSync(["docker", "network", "create", "--internal", "--subnet", subnet, name], { stderr: "pipe" });
    if (proc.exitCode !== 0) throw new Error(proc.stderr.toString());
    try {
      await check();
    } finally {
      Bun.spawnSync(["docker", "network", "rm", name]);
    }
  }

  test("skip slots that overlap a larger Docker network", async () => {
    await withNetwork("10.213.252.0/22", async () => {
      const reserved = new Set(Array.from({ length: 126 }, (_, slot) => slot));
      await expect(freeSlot(reserved)).rejects.toThrow("No free network slot");
    });
  });

  test.each(["10.213.254.64/26", "10.213.254.192/26", "10.213.255.64/26"])("skip and leave out of the count a slot that overlaps the smaller Docker network %s", async (subnet) => {
    await withNetwork(subnet, async () => {
      const reserved = new Set(Array.from({ length: 126 }, (_, slot) => slot));
      expect(await freeSlots(reserved)).toBe(1);
      expect(await freeSlot(reserved)).toBe(126);
      expect(await freeSlots(reserved)).toBe(0);
      await expect(freeSlot(reserved)).rejects.toThrow("No free network slot");
    });
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
      mem_limit: "2147483648",
      cpus: 2,
      pids_limit: 1024,
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
      ipam: { config: [{ subnet: "10.213.6.128/25" }] },
    });
    expect(config.networks.qa_egress).toMatchObject({ ipam: { config: [{ subnet: "10.213.7.0/24" }] } });
    expect(config.networks.qa_egress?.internal).toBeUndefined();
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
    expect(config.services["qa-runner"]?.environment).toMatchObject({ NO_PROXY: "localhost,127.0.0.1", AGENT_BROWSER_ALLOWED_DOMAINS: "" });
  });

  test("reject an environment without egress hosts", async () => {
    const runDir = await scratch();
    expect(() => renderOverride(spec(runDir, null, { egress: [] }), 1000, 1000)).toThrow("has no egress hosts");
  });
});

describe.skipIf(!dockerAvailable)("environment helpers", () => {
  test("add target service limits, the default for unset limits, the runner, and the proxy", async () => {
    const gib = 1024 ** 3;
    const mib = 1024 ** 2;
    const target = await loadTarget(ref, ledgerSource);
    expect(environmentMemory(target)).toBe(4 * gib + 128 * mib);
    const limited: Target = { ...target, services: { ...target.services, db: { build: false, memLimit: 512 * mib, networkMode: null, aliases: [], hasCpus: false, hasPidsLimit: false, deployLimits: false, active: true, replicas: 1 } } };
    expect(environmentMemory(limited)).toBe(3 * gib + 640 * mib);
    const replicated: Target = { ...limited, services: { ...limited.services, db: { ...limited.services.db!, replicas: 3 } } };
    expect(environmentMemory(replicated)).toBe(4 * gib + 640 * mib);
    expect(environmentMemory(null)).toBe(2 * gib + 128 * mib);
  });

  test("leave inactive services out of the memory reservation and the image build", async () => {
    const gib = 1024 ** 3;
    const mib = 1024 ** 2;
    const target = await loadTarget(ref, ledgerSource);
    const profiled: Target = {
      ...target,
      services: { web: { build: true, memLimit: null, networkMode: null, aliases: [], hasCpus: false, hasPidsLimit: false, deployLimits: false, active: false, replicas: 1 } },
    };
    expect(environmentMemory(profiled)).toBe(2 * gib + 128 * mib);
    expect(await buildImages("3f9a1c2e", profiled, ledgerSource)).toEqual({});
  });

  test("route every environment host around the proxy and allow only those hosts in the browser", () => {
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
      AGENT_BROWSER_ALLOWED_DOMAINS: "web,admin.shop.test",
    });
  });

  test("bypass HSTS only for single-label hosts", async () => {
    const runDir = await scratch();
    await writeChromePolicy(runDir, { app: "http://app:3000", api: "http://app:3000/api", dev: "http://dev:5173", admin: "https://admin.shop.test" });
    expect(await Bun.file(join(runDir, "chrome-policy.json")).json()).toEqual({ HSTSPolicyBypassList: ["app", "dev"] });
  });
});
