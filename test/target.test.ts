import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, readlink, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { forgetSecrets, redact } from "../src/secrets.ts";
import { exportTree, loadTarget, resolveTarget } from "../src/target.ts";

const dockerAvailable = Bun.spawnSync(["docker", "info"], { stdout: "ignore", stderr: "ignore" }).exitCode === 0;

const ledger = join(import.meta.dir, "..", "eval", "ledger");
const roots: string[] = [];

afterAll(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true });
});

async function scratch(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

function git(dir: string, ...args: string[]): string {
  const proc = Bun.spawnSync(["git", "-C", dir, "-c", "user.name=QA", "-c", "user.email=qa@example.test", "-c", "commit.gpgsign=false", ...args], { stderr: "pipe" });
  if (proc.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${proc.stderr.toString()}`);
  return proc.stdout.toString().trim();
}

async function commitFiles(root: string, files: Record<string, string>, message: string): Promise<string> {
  for (const [path, content] of Object.entries(files)) await Bun.write(join(root, path), content);
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", message);
  return git(root, "rev-parse", "HEAD");
}

async function repo(files: Record<string, string>): Promise<string> {
  const root = await scratch("qa-interns-target-");
  git(root, "init", "-q");
  await commitFiles(root, files, "fixture");
  return root;
}

async function ledgerFiles(prefix: string): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  for (const path of [".devcontainer/devcontainer.json", ".devcontainer/compose.yml", "Dockerfile", "package.json", "src/server.ts", "src/seed.ts"]) {
    files[`${prefix}${path}`] = await Bun.file(join(ledger, path)).text();
  }
  return files;
}

const settings = {
  urls: { app: "http://web:3000" },
  ready: "http://web:3000/health",
  seed: "bun run src/seed.ts",
};

function devcontainer(extra: Record<string, unknown> = {}, qa: Record<string, unknown> = settings): string {
  return JSON.stringify({ name: "Fixture", dockerComposeFile: "compose.yml", service: "web", customizations: { "qa-interns": qa }, ...extra }, null, 2);
}

function fixture(compose: string, config = devcontainer()): Promise<string> {
  return repo({ ".devcontainer/devcontainer.json": config, ".devcontainer/compose.yml": compose });
}

async function load(root: string) {
  const ref = await resolveTarget(root, "HEAD", false);
  const source = await scratch("qa-interns-source-");
  await exportTree(ref, source);
  return loadTarget(ref, source);
}

describe("resolveTarget and exportTree", () => {
  test("resolve a subdirectory to the repository, its path, and the commit, and export only that tree", async () => {
    const root = await repo({ ...(await ledgerFiles("apps/ledger/")), "README.md": "monorepo\n", "apps/other/index.ts": "export {};\n" });
    const head = git(root, "rev-parse", "HEAD");
    const ref = await resolveTarget(join(root, "apps", "ledger"), "HEAD", false);
    expect(ref).toEqual({ repo: await realpath(root), path: "apps/ledger", commit: head, dirty: false });

    const dest = await scratch("qa-interns-export-");
    await exportTree(ref, dest);
    expect((await readdir(dest)).sort()).toEqual([".devcontainer", "Dockerfile", "package.json", "src"]);
    expect(await Bun.file(join(dest, ".devcontainer", "compose.yml")).text()).toBe(await Bun.file(join(ledger, ".devcontainer", "compose.yml")).text());
  });

  test("export the tree at the resolved commit, not the working tree", async () => {
    const root = await repo({ "app/.devcontainer/devcontainer.json": devcontainer(), "app/VERSION": "one\n" });
    const first = git(root, "rev-parse", "HEAD");
    await commitFiles(root, { "app/VERSION": "two\n" }, "second");
    await Bun.write(join(root, "app", "VERSION"), "uncommitted\n");
    await Bun.write(join(root, "app", "untracked.txt"), "untracked\n");

    const older = await resolveTarget(join(root, "app"), "HEAD~1", false);
    expect(older.commit).toBe(first);
    const olderDest = await scratch("qa-interns-export-");
    await exportTree(older, olderDest);
    expect(await Bun.file(join(olderDest, "VERSION")).text()).toBe("one\n");

    const head = await resolveTarget(join(root, "app"), "HEAD", false);
    const headDest = await scratch("qa-interns-export-");
    await exportTree(head, headDest);
    expect(await Bun.file(join(headDest, "VERSION")).text()).toBe("two\n");
    expect(await Bun.file(join(headDest, "untracked.txt")).exists()).toBe(false);
  });

  test("export the working tree of a dirty target: tracked files as they are, untracked files, and no ignored, deleted, or sparse-checkout-omitted file", async () => {
    const root = await repo({
      "app/.devcontainer/devcontainer.json": devcontainer(),
      "app/.gitignore": "node_modules/\n.env\n",
      "app/VERSION": "one\n",
      "app/assets/large.bin": "large\n",
      "app/src/removed.ts": "export {};\n",
      "app/src/-C": "tracked\n",
      "other/README.md": "outside the target\n",
    });
    await symlink("../VERSION", join(root, "app", "src", "version-link"));
    git(root, "add", "-A");
    git(root, "commit", "-q", "-m", "link");
    const head = git(root, "rev-parse", "HEAD");
    await Bun.write(join(root, "app", "VERSION"), "uncommitted\n");
    await rm(join(root, "app", "src", "removed.ts"));
    git(root, "update-index", "--skip-worktree", "app/assets/large.bin");
    await rm(join(root, "app", "assets"), { recursive: true });
    await Bun.write(join(root, "app", "src", "new file.ts"), "export const added = true;\n");
    await Bun.write(join(root, "app", ".env"), "SECRET=local\n");
    await Bun.write(join(root, "app", "node_modules", "dep", "index.js"), "module.exports = {};\n");
    await Bun.write(join(root, "other", "untracked.txt"), "outside the target\n");

    const ref = await resolveTarget(join(root, "app"), "HEAD", true);
    expect(ref).toEqual({ repo: await realpath(root), path: "app", commit: head, dirty: true });
    const dest = await scratch("qa-interns-export-");
    await exportTree(ref, dest);
    expect((await readdir(dest, { recursive: true })).sort()).toEqual([".devcontainer", ".devcontainer/devcontainer.json", ".gitignore", "VERSION", "src", "src/-C", "src/new file.ts", "src/version-link"]);
    expect(await Bun.file(join(dest, "VERSION")).text()).toBe("uncommitted\n");
    expect(await Bun.file(join(dest, "src", "new file.ts")).text()).toBe("export const added = true;\n");
    expect(await readlink(join(dest, "src", "version-link"))).toBe("../VERSION");
    expect(git(root, "diff", "--cached", "--name-only")).toBe("");
  });

  test("resolve the repository root to an empty path and export the whole tree", async () => {
    const root = await repo({ "app.ts": "export {};\n", ".devcontainer/devcontainer.json": devcontainer() });
    const ref = await resolveTarget(root, "HEAD", false);
    expect(ref.path).toBe("");
    const dest = await scratch("qa-interns-export-");
    await exportTree(ref, dest);
    expect((await readdir(dest)).sort()).toEqual([".devcontainer", "app.ts"]);
  });

  test("reject a revision that does not exist", async () => {
    const root = await repo({ "app.ts": "export {};\n" });
    await expect(resolveTarget(root, "no-such-branch", false)).rejects.toThrow("no-such-branch^{commit}");
  });
});

describe.skipIf(!dockerAvailable)("loadTarget", () => {
  test("load the Ledger target", async () => {
    const root = await repo(await ledgerFiles(""));
    const target = await load(root);
    expect(target.settings).toEqual({
      urls: { app: "http://web:3000" },
      ready: "http://web:3000/health",
      seed: "bun run src/seed.ts",
      focus: [
        "How invoices calculate, store, and show money across currencies, lists, and exports.",
        "What owners, editors, and viewers can see and change, in the pages and in the API.",
      ],
      offLimits: ["Do not change the password of a seeded account."],
      knownGaps: [],
      hostEnv: [],
      secrets: { hostEnv: [], seed: [] },
      egress: [],
    });
    expect(target.composeFiles).toEqual(["compose.yml"]);
    expect(target.service).toBe("web");
    expect(target.config.workspaceFolder).toBe("/app");
    expect(target.services).toEqual({
      web: { build: true, image: null, tags: [], memLimit: null, networkMode: null, aliases: [], hasCpus: false, hasPidsLimit: false, deployLimits: false, active: true, replicas: 1 },
      db: { build: false, image: "postgres:17.11-alpine", tags: [], memLimit: null, networkMode: null, aliases: [], hasCpus: false, hasPidsLimit: false, deployLimits: false, active: true, replicas: 1 },
    });
  });

  test("read limits from the service or its deploy section, the network mode, and services behind a profile", async () => {
    const compose = `services:
  web:
    image: nginx:1.29-alpine
    mem_limit: 512m
    cpus: 1.5
    pids_limit: 200
  sidecar:
    image: busybox:1.37
    network_mode: "service:web"
  worker:
    build: ./worker
    deploy:
      resources:
        limits:
          memory: 256M
          cpus: "0.5"
          pids: 64
  mailer:
    image: axllent/mailpit:v1.27
    profiles: ["mail"]
`;
    const target = await load(await fixture(compose, devcontainer({ dockerComposeFile: ["compose.yml"] })));
    expect(target.services).toEqual({
      web: { build: false, image: "nginx:1.29-alpine", tags: [], memLimit: 536870912, networkMode: null, aliases: [], hasCpus: true, hasPidsLimit: true, deployLimits: false, active: true, replicas: 1 },
      sidecar: { build: false, image: "busybox:1.37", tags: [], memLimit: null, networkMode: "service:web", aliases: [], hasCpus: false, hasPidsLimit: false, deployLimits: false, active: true, replicas: 1 },
      worker: { build: true, image: null, tags: [], memLimit: 268435456, networkMode: null, aliases: [], hasCpus: true, hasPidsLimit: true, deployLimits: true, active: true, replicas: 1 },
      mailer: { build: false, image: "axllent/mailpit:v1.27", tags: [], memLimit: null, networkMode: null, aliases: [], hasCpus: false, hasPidsLimit: false, deployLimits: false, active: false, replicas: 1 },
    });
  });

  test("treat a service behind a profile as active when it is the dev container service or in runServices", async () => {
    const compose = `services:
  web:
    image: nginx:1.29-alpine
    profiles: ["dev"]
  worker:
    image: busybox:1.37
    profiles: ["jobs"]
  mailer:
    image: axllent/mailpit:v1.27
    profiles: ["mail"]
`;
    const target = await load(await fixture(compose, devcontainer({ runServices: ["worker"] })));
    expect(Object.fromEntries(Object.entries(target.services).map(([name, service]) => [name, service.active]))).toEqual({ web: true, worker: true, mailer: false });
  });

  test("treat dependencies behind the profile of a service in runServices as active and an optional one behind another profile as inactive", async () => {
    const compose = `services:
  web:
    image: nginx:1.29-alpine
    depends_on:
      tracing:
        condition: service_started
        required: false
  worker:
    image: busybox:1.37
    profiles: ["jobs"]
    depends_on:
      queue:
        condition: service_started
      scheduler:
        condition: service_started
        required: false
  queue:
    image: redis:8.2-alpine
    profiles: ["jobs"]
  scheduler:
    image: busybox:1.37
    profiles: ["jobs"]
  tracing:
    image: jaegertracing/jaeger:2.9.0
    profiles: ["tracing"]
  mailer:
    image: axllent/mailpit:v1.27
    profiles: ["mail"]
`;
    const target = await load(await fixture(compose, devcontainer({ runServices: ["worker"] })));
    expect(Object.fromEntries(Object.entries(target.services).map(([name, service]) => [name, service.active]))).toEqual({
      web: true,
      worker: true,
      queue: true,
      scheduler: true,
      tracing: false,
      mailer: false,
    });
  });

  test("count a service's containers from scale or deploy.replicas", async () => {
    const compose = `services:
  web:
    image: nginx:1.29-alpine
  worker:
    image: busybox:1.37
    scale: 3
  queue:
    image: redis:8.2-alpine
    deploy:
      replicas: 2
`;
    const target = await load(await fixture(compose, devcontainer({})));
    expect(Object.fromEntries(Object.entries(target.services).map(([name, service]) => [name, service.replicas]))).toEqual({ web: 1, worker: 3, queue: 2 });
  });

  test("treat services behind a profile that the target's .env enables as active", async () => {
    const compose = `services:
  web:
    image: nginx:1.29-alpine
    depends_on:
      tracing:
        condition: service_started
        required: false
  tools:
    build: ./tools
    image: shop/tools:latest
    profiles: ["tools"]
  tracing:
    image: jaegertracing/jaeger:2.9.0
    profiles: ["tracing"]
  mailer:
    image: axllent/mailpit:v1.27
    profiles: ["mail"]
`;
    const root = await repo({ ".devcontainer/devcontainer.json": devcontainer(), ".devcontainer/compose.yml": compose, ".devcontainer/.env": "COMPOSE_PROFILES=tools,tracing\n" });
    const target = await load(root);
    expect(Object.fromEntries(Object.entries(target.services).map(([name, service]) => [name, service.active]))).toEqual({
      web: true,
      tools: true,
      tracing: true,
      mailer: false,
    });
  });

  test("resolve Compose variables from the host only for the names hostEnv lists", async () => {
    process.env.QA_INTERNS_TEST_MOUNT = "/etc";
    try {
      const compose = 'services:\n  web:\n    image: nginx:1.29-alpine\n    volumes: ["${QA_INTERNS_TEST_MOUNT:-./data}:/data"]\n';
      expect(Object.keys((await load(await fixture(compose))).services)).toEqual(["web"]);
      const listed = devcontainer({}, { ...settings, hostEnv: ["QA_INTERNS_TEST_MOUNT"] });
      await expect(load(await fixture(compose, listed))).rejects.toThrow("service web mounts /etc, which resolves to /etc, outside the target directory");
    } finally {
      delete process.env.QA_INTERNS_TEST_MOUNT;
    }
  });

  test("keep the value of each secrets.hostEnv variable for redaction before a check can quote it", async () => {
    const mount = await scratch("qa-interns-secret-mount-");
    process.env.QA_INTERNS_TEST_MOUNT = mount;
    try {
      const compose = 'services:\n  web:\n    image: nginx:1.29-alpine\n    volumes: ["${QA_INTERNS_TEST_MOUNT}:/data"]\n';
      const listed = devcontainer({}, { ...settings, hostEnv: ["QA_INTERNS_TEST_MOUNT"], secrets: { hostEnv: ["QA_INTERNS_TEST_MOUNT"] } });
      await expect(load(await fixture(compose, listed))).rejects.toThrow(`service web mounts ${mount}`);
      expect(redact(`service web mounts ${mount}`)).toBe("service web mounts [redacted]");
    } finally {
      forgetSecrets();
      delete process.env.QA_INTERNS_TEST_MOUNT;
    }
  });

  test("resolve DOCKER_CONFIG in Compose files to the Docker client configuration copy that builds and environments get", async () => {
    const hostConfig = process.env.DOCKER_CONFIG;
    delete process.env.DOCKER_CONFIG;
    try {
      const compose = 'services:\n  web:\n    image: nginx:1.29-alpine\n    volumes: ["${DOCKER_CONFIG:-./data}:/data"]\n';
      await expect(load(await fixture(compose))).rejects.toThrow("service web mounts ");
    } finally {
      if (hostConfig !== undefined) process.env.DOCKER_CONFIG = hostConfig;
    }
  });

  test("treat an unlimited pids_limit as no limit", async () => {
    const compose = `services:
  web:
    image: nginx:1.29-alpine
    pids_limit: -1
`;
    const target = await load(await fixture(compose, devcontainer({})));
    expect(target.services.web?.hasPidsLimit).toBe(false);
  });

  const unsafe: [string, string, string][] = [
    ["container_name", "  web:\n    image: nginx:1.29-alpine\n    container_name: shop-web\n", "service web sets container_name shop-web"],
    ["network_mode host", "  web:\n    image: nginx:1.29-alpine\n    network_mode: host\n", "service web sets network_mode host"],
    ["network_mode bridge", "  web:\n    image: nginx:1.29-alpine\n    network_mode: bridge\n", "service web sets network_mode bridge"],
    [
      "external volume",
      "  web:\n    image: nginx:1.29-alpine\n    volumes: [\"uploads:/data\"]\nvolumes:\n  uploads:\n    external: true\n    name: shop-uploads\n",
      "volume uploads is external (shop-uploads)",
    ],
    ["named volume", "  web:\n    image: nginx:1.29-alpine\n    volumes: [\"uploads:/data\"]\nvolumes:\n  uploads:\n    name: shop-uploads\n", "volume uploads sets name shop-uploads"],
    ["external network", "  web:\n    image: nginx:1.29-alpine\n    networks: [\"shared\"]\nnetworks:\n  shared:\n    external: true\n", "network shared is external (shared)"],
    ["named network", "  web:\n    image: nginx:1.29-alpine\n    networks: [\"backend\"]\nnetworks:\n  backend:\n    name: shop-backend\n", "network backend sets name shop-backend"],
    ["privileged", "  web:\n    image: nginx:1.29-alpine\n    privileged: true\n", "service web sets privileged"],
    ["pid host", "  web:\n    image: nginx:1.29-alpine\n    pid: host\n", "service web sets pid host"],
    [
      "the Docker socket",
      "  web:\n    image: nginx:1.29-alpine\n    volumes: [\"/var/run/docker.sock:/var/run/docker.sock\"]\n",
      "service web mounts /var/run/docker.sock, which resolves to ",
    ],
    [
      "the Docker socket under /run in long syntax",
      "  web:\n    image: nginx:1.29-alpine\n    volumes:\n      - type: bind\n        source: /run/docker.sock\n        target: /docker.sock\n        read_only: true\n",
      "service web mounts /run/docker.sock, which resolves to ",
    ],
    ["a host folder", "  web:\n    image: nginx:1.29-alpine\n    volumes: [\"/etc:/host-etc:ro\"]\n", "service web mounts /etc, which resolves to /etc, outside the target directory"],
    ["ipc host", "  web:\n    image: nginx:1.29-alpine\n    ipc: host\n", "service web sets ipc host"],
    ["userns_mode host", "  web:\n    image: nginx:1.29-alpine\n    userns_mode: host\n", "service web sets userns_mode host"],
    ["a device", "  web:\n    image: nginx:1.29-alpine\n    devices: [\"/dev/fuse:/dev/fuse\"]\n", "service web maps device /dev/fuse"],
    ["an added capability", "  web:\n    image: nginx:1.29-alpine\n    cap_add: [\"NET_ADMIN\"]\n", "service web adds capability NET_ADMIN"],
    ["an unconfined security option", "  web:\n    image: nginx:1.29-alpine\n    security_opt: [\"seccomp:unconfined\"]\n", "service web sets security_opt seccomp:unconfined"],
    [
      "a network alias that names another service",
      "  web:\n    image: nginx:1.29-alpine\n    networks:\n      default:\n        aliases: [\"db\"]\n  db:\n    image: postgres:17-alpine\n",
      "service web declares network alias db, the name of another service",
    ],
    [
      "a network alias that QA Interns reserves",
      "  web:\n    image: nginx:1.29-alpine\n    networks:\n      default:\n        aliases: [\"qa-proxy\"]\n",
      "service web declares network alias qa-proxy, a name QA Interns reserves",
    ],
    ["a service named qa-relay", "  web:\n    image: nginx:1.29-alpine\n  qa-relay:\n    image: nginx:1.29-alpine\n", "service qa-relay uses a name QA Interns reserves"],
    ["a service named QA-Proxy", "  web:\n    image: nginx:1.29-alpine\n  QA-Proxy:\n    image: nginx:1.29-alpine\n", "service QA-Proxy uses a name QA Interns reserves"],
    [
      "a network alias two services declare",
      "  web:\n    image: nginx:1.29-alpine\n    networks:\n      default:\n        aliases: [\"shop\"]\n  api:\n    image: nginx:1.29-alpine\n    networks:\n      default:\n        aliases: [\"shop\"]\n",
      "services api and web both declare network alias shop",
    ],
    [
      "two buildable services whose names differ only by case",
      "  web:\n    build: .\n  Web:\n    build: .\n",
      "services Web and web differ only by case, so their names and prebuilt image tags collide",
    ],
    [
      "a privileged service behind a profile",
      "  web:\n    image: nginx:1.29-alpine\n  debug:\n    image: busybox:1.37\n    profiles: [\"debug\"]\n    privileged: true\n",
      "service debug sets privileged",
    ],
    ["uts host", "  web:\n    image: nginx:1.29-alpine\n    uts: host\n", "service web sets uts host"],
    ["a seccomp profile from a file", "  web:\n    image: nginx:1.29-alpine\n    security_opt: [\"seccomp=../allow.json\"]\n", "service web sets security_opt seccomp=../allow.json"],
    ["the pid namespace of a container outside the project", "  web:\n    image: nginx:1.29-alpine\n    pid: \"container:shop-db\"\n", "service web sets pid container:shop-db"],
    ["the ipc namespace of a container outside the project", "  web:\n    image: nginx:1.29-alpine\n    ipc: \"container:shop-db\"\n", "service web sets ipc container:shop-db"],
    ["a build on the host network", "  web:\n    build:\n      context: ..\n      network: host\n", "service web builds on network host"],
    ["a privileged build", "  web:\n    build:\n      context: ..\n      privileged: true\n", "service web builds privileged"],
    ["a build entitlement", "  web:\n    build:\n      context: ..\n      entitlements: [\"security.insecure\"]\n", "service web builds with entitlement security.insecure"],
    ["SSH agent forwarding into a build", "  web:\n    build:\n      context: ..\n      ssh: [\"default\"]\n", "service web builds with SSH default"],
    ["a build cache read with exporter attributes", "  web:\n    build:\n      context: ..\n      cache_from: [\"TYPE=local,src=/srv/cache\"]\n", "service web builds with cache_from TYPE=local,src=/srv/cache"],
    ["a build cache written anywhere", "  web:\n    build:\n      context: ..\n      cache_to: [\"type=registry,ref=shop/web:buildcache\"]\n", "service web builds with cache_to type=registry,ref=shop/web:buildcache"],
    ["cgroup host", "  web:\n    image: nginx:1.29-alpine\n    cgroup: host\n", "service web sets cgroup host"],
    [
      "a privileged lifecycle hook",
      "  web:\n    image: nginx:1.29-alpine\n    post_start:\n      - command: [\"sysctl\", \"-w\", \"kernel.core_pattern=/tmp/core\"]\n        privileged: true\n",
      "service web runs a privileged post_start hook",
    ],
    ["a device cgroup rule", "  web:\n    image: nginx:1.29-alpine\n    device_cgroup_rules: [\"b 8:* rmw\"]\n", "service web sets device_cgroup_rules b 8:* rmw"],
    ["GPUs", "  web:\n    image: nginx:1.29-alpine\n    gpus: all\n", "service web requests GPUs"],
    ["a container runtime other than runc", "  web:\n    image: nginx:1.29-alpine\n    runtime: nvidia\n", "service web sets runtime nvidia"],
    [
      "a device reservation",
      "  web:\n    image: nginx:1.29-alpine\n    deploy:\n      resources:\n        reservations:\n          devices:\n            - capabilities: [\"gpu\"]\n",
      "service web reserves devices",
    ],
    ["the Docker API socket", "  web:\n    image: nginx:1.29-alpine\n    use_api_socket: true\n", "service web sets use_api_socket"],
    ["volumes from a container outside the project", "  web:\n    image: nginx:1.29-alpine\n    volumes_from: [\"container:shared-uploads\"]\n", "service web takes volumes from container:shared-uploads"],
    [
      "a volume whose driver options bind a host folder",
      "  web:\n    image: nginx:1.29-alpine\n    volumes: [\"uploads:/data\"]\nvolumes:\n  uploads:\n    driver: local\n    driver_opts: { type: none, o: bind, device: /srv/uploads }\n",
      "volume uploads sets driver_opts",
    ],
    ["a volume driver other than local", "  web:\n    image: nginx:1.29-alpine\n    volumes: [\"uploads:/data\"]\nvolumes:\n  uploads:\n    driver: rclone\n", "volume uploads uses driver rclone"],
    ["an env_file outside the target", "  web:\n    image: nginx:1.29-alpine\n    env_file: /etc/hostname\n", "service web reads env_file /etc/hostname, which resolves to /etc/hostname, outside the target directory"],
    ["an env_file path that a variable points outside the target", "  web:\n    image: nginx:1.29-alpine\n    env_file: ${HOME}/.config/shop/app.env\n", "/.config/shop/app.env, which resolves to "],
    [
      "a secret file outside the target",
      "  web:\n    image: nginx:1.29-alpine\n    secrets: [\"hosts\"]\nsecrets:\n  hosts:\n    file: /etc/hosts\n",
      "secret hosts reads file /etc/hosts, which resolves to /etc/hosts, outside the target directory",
    ],
    [
      "a config file outside the target",
      "  web:\n    image: nginx:1.29-alpine\n    configs: [\"hosts\"]\nconfigs:\n  hosts:\n    file: /etc/hosts\n",
      "config hosts reads file /etc/hosts, which resolves to /etc/hosts, outside the target directory",
    ],
    ["a build context outside the target", "  web:\n    build: /etc\n", "service web builds from context /etc, which resolves to /etc, outside the target directory"],
    [
      "a Dockerfile outside the target",
      "  web:\n    build:\n      context: ..\n      dockerfile: /etc/hostname\n",
      "service web builds from Dockerfile /etc/hostname, which resolves to /etc/hostname, outside the target directory",
    ],
    [
      "an additional build context outside the target",
      "  web:\n    build:\n      context: ..\n      additional_contexts:\n        host: /etc\n",
      "service web builds with additional context host /etc, which resolves to /etc, outside the target directory",
    ],
    [
      "an additional build context from a host OCI layout",
      "  web:\n    build:\n      context: ..\n      additional_contexts:\n        base: oci-layout:///srv/layouts/base\n",
      "service web builds with additional context base from host OCI layout oci-layout:///srv/layouts/base",
    ],
  ];

  test.each(unsafe)("reject %s", async (_, services, message) => {
    const root = await fixture(`services:\n${services}`);
    await expect(load(root)).rejects.toThrow(message);
  });

  test("report every unsafe pattern in one error", async () => {
    const compose = `services:
  web:
    image: nginx:1.29-alpine
    container_name: shop-web
    volumes: ["uploads:/data", "cache:/cache"]
    networks: ["shared", "backend"]
  db:
    image: postgres:17-alpine
    network_mode: host
volumes:
  uploads:
    external: true
    name: shop-uploads
  cache:
    name: shop-cache
networks:
  shared:
    external: true
  backend:
    name: shop-backend
`;
    const error = await load(await fixture(compose)).catch((reason: unknown) => reason);
    if (!(error instanceof Error)) throw new Error("loadTarget accepted unsafe Compose files");
    const lines = error.message.split("\n").filter((line) => line.startsWith("- "));
    expect(lines.sort()).toEqual(
      [
        "- network backend sets name shop-backend",
        "- network shared is external (shared)",
        "- service db sets network_mode host",
        "- service web sets container_name shop-web",
        "- volume cache sets name shop-cache",
        "- volume uploads is external (shop-uploads)",
      ].sort(),
    );
  });

  test("accept fixed host ports, which the override removes", async () => {
    const target = await load(await fixture("services:\n  web:\n    image: nginx:1.29-alpine\n    ports: [\"8080:80\"]\n"));
    expect(Object.keys(target.services)).toEqual(["web"]);
  });

  test("accept bind mounts of the target, a missing folder inside it, and a confined security option", async () => {
    const compose = "services:\n  web:\n    image: nginx:1.29-alpine\n    volumes: [\"..:/app\", \"./data:/data\"]\n    security_opt: [\"no-new-privileges:true\"]\n";
    const target = await load(await fixture(compose));
    expect(Object.keys(target.services)).toEqual(["web"]);
  });

  test("accept host paths inside the target and build contexts that name no host path", async () => {
    const compose = `services:
  web:
    build:
      context: ..
      dockerfile: Dockerfile
      additional_contexts:
        base: docker-image://alpine:3.22
        docs: https://github.com/docker/buildx.git
      network: none
      cache_from: ["shop/web:buildcache"]
    env_file: ["../app.env"]
    secrets: ["token"]
    configs: ["nginx"]
    volumes_from: ["db"]
    volumes: ["cache:/cache"]
  db:
    image: postgres:17-alpine
    volumes: ["../data/postgres:/var/lib/postgresql/data"]
secrets:
  token:
    file: ../token.txt
configs:
  nginx:
    content: "server { listen 80; }"
volumes:
  cache:
    driver: local
`;
    const root = await repo({
      ".devcontainer/devcontainer.json": devcontainer(),
      ".devcontainer/compose.yml": compose,
      "Dockerfile": "FROM nginx:1.29-alpine\n",
      "app.env": "APP_MODE=test\n",
      "token.txt": "sandbox-token\n",
    });
    const target = await load(root);
    expect(Object.keys(target.services)).toEqual(["db", "web"]);
  });

  test("reject a bind mount through a symbolic link in the target that points outside it", async () => {
    const root = await fixture("services:\n  web:\n    image: nginx:1.29-alpine\n    volumes: [\"../host:/host\"]\n");
    await symlink("/etc", join(root, "host"));
    git(root, "add", "-A");
    git(root, "commit", "-q", "-m", "link");
    await expect(load(root)).rejects.toThrow("/host, which resolves to /etc, outside the target directory");
  });

  test("reject a project .env file that is a symbolic link to a host file", async () => {
    const outside = await scratch("qa-interns-outside-");
    await Bun.write(join(outside, "host.env"), "TAG=from-host\n");
    const root = await fixture("services:\n  web:\n    image: busybox:${TAG:-1.37}\n");
    await symlink(join(outside, "host.env"), join(root, ".devcontainer", ".env"));
    git(root, "add", "-A");
    git(root, "commit", "-q", "-m", "link");
    await expect(load(root)).rejects.toThrow(`/.devcontainer/.env, which resolves to ${await realpath(outside)}/host.env, outside the target directory`);
  });

  test("reject a missing bind source under a symbolic link in the target that points outside it", async () => {
    const outside = await scratch("qa-interns-outside-");
    const root = await fixture("services:\n  web:\n    image: nginx:1.29-alpine\n    volumes: [\"../shared/uploads:/data\"]\n");
    await symlink(outside, join(root, "shared"));
    git(root, "add", "-A");
    git(root, "commit", "-q", "-m", "link");
    await expect(load(root)).rejects.toThrow(`/shared/uploads, which resolves to ${await realpath(outside)}/uploads, outside the target directory`);
  });

  test("reject a Compose file outside the target, by its path or through a symbolic link", async () => {
    const compose = "services:\n  web:\n    image: nginx:1.29-alpine\n";
    const parent = await fixture(compose, devcontainer({ dockerComposeFile: ["compose.yml", "../../outside.yml"] }));
    await expect(load(parent)).rejects.toThrow("names the Compose file ../../outside.yml, which resolves outside the target directory");

    const outside = await scratch("qa-interns-outside-");
    await Bun.write(join(outside, "compose.yml"), compose);
    const linked = await fixture(compose, devcontainer({ dockerComposeFile: "linked.yml" }));
    await symlink(join(outside, "compose.yml"), join(linked, ".devcontainer", "linked.yml"));
    git(linked, "add", "-A");
    git(linked, "commit", "-q", "-m", "link");
    await expect(load(linked)).rejects.toThrow("names the Compose file linked.yml, which resolves outside the target directory");
  });

  test("accept include and extends files inside the target, resolved the way Compose resolves them", async () => {
    const root = await repo({
      ".devcontainer/devcontainer.json": devcontainer({ dockerComposeFile: ["compose.yml", "extra/second.yml"] }),
      ".devcontainer/compose.yml": `include:
  - inc/worker.yml
  - path: inc/cron.yml
    project_directory: ..
    env_file: ../cron.env
  - path: inc/job/job.yml
    project_directory: ""
    env_file: /dev/null
services:
  web:
    extends: { file: base.yml, service: base }
`,
      ".devcontainer/extra/second.yml": "include:\nservices:\n  extra:\n    extends: { file: base.yml, service: base }\n  gone: !reset null\n",
      ".devcontainer/base.yml": "services:\n  base:\n    image: nginx:1.29-alpine\n",
      ".devcontainer/inc/worker.yml": "include: [queue.yml]\nservices:\n  worker:\n    extends: { file: ../chain/mid.yml, service: mid }\n",
      ".devcontainer/inc/queue.yml": "services:\n  queue:\n    image: redis:8.2-alpine\n",
      ".devcontainer/inc/cron.yml": "services:\n  cron:\n    extends: { file: .devcontainer/base.yml, service: base }\n    image: busybox:${CRON_TAG}\n",
      ".devcontainer/inc/job/job.yml": "services:\n  job:\n    extends: { file: jobbase.yml, service: base }\n",
      ".devcontainer/inc/job/jobbase.yml": "services:\n  base:\n    image: busybox:1.37\n",
      ".devcontainer/chain/mid.yml": "include: [missing.yml]\nservices:\n  mid:\n    extends: { file: leaf.yml, service: leaf }\n",
      ".devcontainer/chain/leaf.yml": "services:\n  leaf:\n    image: nginx:1.29-alpine\n",
      "cron.env": "CRON_TAG=1.37\n",
    });
    const target = await load(root);
    expect(Object.keys(target.services).sort()).toEqual(["cron", "extra", "job", "queue", "web", "worker"]);
  });

  const outsideReferences: [string, (outside: string) => [Record<string, string>, string]][] = [
    [
      "an include outside the target",
      (outside) => [{ "compose.yml": `include: [${outside}/extra.yml]\nservices:\n  web:\n    image: nginx:1.29-alpine\n` }, `compose.yml names ${outside}/extra.yml in include, which does not resolve`],
    ],
    [
      "an extends file outside the target",
      (outside) => [{ "compose.yml": `services:\n  web:\n    extends: { file: ${outside}/base.yml, service: base }\n` }, `compose.yml names ${outside}/base.yml in services.web.extends.file, which`],
    ],
    [
      "a scalar include",
      (outside) => [{ "compose.yml": `include: ${outside}/extra.yml\nservices:\n  web:\n    image: nginx:1.29-alpine\n` }, "compose.yml is invalid"],
    ],
    [
      "an include outside the target in an included file",
      (outside) => [
        { "compose.yml": "include: [inc/a.yml]\nservices:\n  web:\n    image: nginx:1.29-alpine\n", "inc/a.yml": `include: [${outside}/extra.yml]\n` },
        `inc/a.yml names ${outside}/extra.yml in include, which`,
      ],
    ],
    [
      "an extends file outside the target in an extended file",
      (outside) => [
        { "compose.yml": "services:\n  web:\n    extends: { file: inc/b.yml, service: b }\n", "inc/b.yml": `services:\n  b:\n    extends: { file: ${outside}/base.yml, service: base }\n` },
        `inc/b.yml names ${outside}/base.yml in services.b.extends.file, which`,
      ],
    ],
    [
      "an include project directory outside the target",
      (outside) => [
        { "compose.yml": `include: [{ path: inc/a.yml, project_directory: ${outside} }]\nservices:\n  web:\n    image: nginx:1.29-alpine\n`, "inc/a.yml": "services: {}\n" },
        `compose.yml names ${outside} in include.project_directory, which`,
      ],
    ],
    [
      "an include env file outside the target",
      (outside) => [
        { "compose.yml": `include: [{ path: inc/a.yml, env_file: ${outside}/extra.env }]\nservices:\n  web:\n    image: nginx:1.29-alpine\n`, "inc/a.yml": "services: {}\n" },
        `compose.yml names ${outside}/extra.env in include.env_file, which`,
      ],
    ],
    [
      "a relative project directory on an include in an included file",
      () => [
        { "compose.yml": "include: [inc/a.yml]\nservices:\n  web:\n    image: nginx:1.29-alpine\n", "inc/a.yml": "include: [{ path: c.yml, project_directory: . }]\n", "inc/c.yml": "services: {}\n" },
        "inc/a.yml names . in include.project_directory, a relative path that Compose resolves against the directory it runs in",
      ],
    ],
    [
      "an OCI include",
      () => [
        { "compose.yml": "include: [oci://qa-interns.invalid/compose:1]\nservices:\n  web:\n    image: nginx:1.29-alpine\n" },
        "compose.yml names oci://qa-interns.invalid/compose:1 in include, which Compose may expand or load from a remote source",
      ],
    ],
    [
      "a Git include in SCP form, even when that literal path is committed",
      () => [
        { "compose.yml": "include: [\"git@qa-interns.invalid:compose.git\"]\nservices:\n  web:\n    image: nginx:1.29-alpine\n", "git@qa-interns.invalid:compose.git": "services: {}\n" },
        "compose.yml names git@qa-interns.invalid:compose.git in include, which Compose may expand or load from a remote source",
      ],
    ],
    [
      "a GitHub include, even when that literal path is committed",
      () => [
        { "compose.yml": "include: [github.com/qa-interns/compose]\nservices:\n  web:\n    image: nginx:1.29-alpine\n", "github.com/qa-interns/compose": "services: {}\n" },
        "compose.yml names github.com/qa-interns/compose in include, which Compose may expand or load from a remote source",
      ],
    ],
    [
      "an extends file with a variable, even when that literal path is committed",
      () => [
        { "compose.yml": "services:\n  web:\n    extends: { file: \"${QA_INTERNS_DIR}/base.yml\", service: base }\n", "${QA_INTERNS_DIR}/base.yml": "services:\n  base:\n    image: nginx:1.29-alpine\n" },
        "compose.yml names ${QA_INTERNS_DIR}/base.yml in services.web.extends.file, which Compose may expand or load from a remote source",
      ],
    ],
    [
      "an extends file under the home directory, even when that literal path is committed",
      () => [
        { "compose.yml": "services:\n  web:\n    extends: { file: \"~/base.yml\", service: base }\n", "~/base.yml": "services:\n  base:\n    image: nginx:1.29-alpine\n" },
        "compose.yml names ~/base.yml in services.web.extends.file, which Compose may expand or load from a remote source",
      ],
    ],
  ];

  test.each(outsideReferences)("reject %s", async (_, cases) => {
    const outside = await scratch("qa-interns-outside-");
    await Bun.write(join(outside, "extra.yml"), "services:\n  worker:\n    image: busybox:1.37\n");
    await Bun.write(join(outside, "base.yml"), "services:\n  base:\n    image: busybox:1.37\n");
    await Bun.write(join(outside, "extra.env"), "TAG=1.37\n");
    const [files, message] = cases(outside);
    const root = await repo({ ".devcontainer/devcontainer.json": devcontainer(), ...Object.fromEntries(Object.entries(files).map(([path, content]) => [`.devcontainer/${path}`, content])) });
    await expect(load(root)).rejects.toThrow(message);
  });

  test("reject an include through a symbolic link in the target that points outside it", async () => {
    const outside = await scratch("qa-interns-outside-");
    await Bun.write(join(outside, "extra.yml"), "services:\n  worker:\n    image: busybox:1.37\n");
    const root = await fixture("include: [linked.yml]\nservices:\n  web:\n    image: nginx:1.29-alpine\n");
    await symlink(join(outside, "extra.yml"), join(root, ".devcontainer", "linked.yml"));
    git(root, "add", "-A");
    git(root, "commit", "-q", "-m", "link");
    await expect(load(root)).rejects.toThrow("compose.yml names linked.yml in include, which does not resolve to an existing path inside the target directory");
  });

  test("reject an included project whose .env file is a symbolic link that points outside the target", async () => {
    const outside = await scratch("qa-interns-outside-");
    await Bun.write(join(outside, "host.env"), "TAG=1.37\n");
    const root = await repo({
      ".devcontainer/devcontainer.json": devcontainer(),
      ".devcontainer/compose.yml": "include: [inc/a.yml]\nservices:\n  web:\n    image: nginx:1.29-alpine\n",
      ".devcontainer/inc/a.yml": "services:\n  worker:\n    image: busybox:${TAG}\n",
    });
    await symlink(join(outside, "host.env"), join(root, ".devcontainer", "inc", ".env"));
    git(root, "add", "-A");
    git(root, "commit", "-q", "-m", "link");
    await expect(load(root)).rejects.toThrow("compose.yml includes inc/a.yml, whose project directory has a .env file that resolves outside the target directory");
  });

  test("reject a single-container dev container", async () => {
    const config = JSON.stringify({ name: "Image", image: "mcr.microsoft.com/devcontainers/typescript-node:22", customizations: { "qa-interns": settings } });
    const root = await repo({ ".devcontainer/devcontainer.json": config });
    await expect(load(root)).rejects.toThrow("Single-container dev containers are not supported yet");
  });

  test("reject a service that is not in the Compose files", async () => {
    const root = await fixture("services:\n  api:\n    image: nginx:1.29-alpine\n");
    await expect(load(root)).rejects.toThrow("names service web, which is not in its Compose files");
  });

  test("parse JSONC with comments and trailing commas", async () => {
    const config = `{
  // Compose dev container
  "dockerComposeFile": "compose.yml",
  "service": "web",
  "customizations": {
    "qa-interns": {
      "urls": { "app": "http://web:8080", "admin": "https://admin.shop.test", },
      "ready": "curl -fsS http://localhost:8080/health",
      "seed": "node seed.mjs",
    },
  },
}`;
    const target = await load(await fixture("services:\n  web:\n    image: nginx:1.29-alpine\n", config));
    expect(target.settings).toEqual({
      urls: { app: "http://web:8080", admin: "https://admin.shop.test" },
      ready: "curl -fsS http://localhost:8080/health",
      seed: "node seed.mjs",
      focus: [],
      offLimits: [],
      knownGaps: [],
      hostEnv: [],
      secrets: { hostEnv: [], seed: [] },
      egress: [],
    });
  });

  test("reject an egress host that is the name or a network alias of a service", async () => {
    const compose = 'services:\n  web:\n    image: nginx:1.29-alpine\n    networks:\n      default:\n        aliases: ["shop.example.test"]\n  api.example.test:\n    image: nginx:1.29-alpine\n';
    const qa = { ...settings, egress: ["shop.example.test", "api.example.test", "api.pwnedpasswords.com"] };
    const error = await load(await fixture(compose, devcontainer({}, qa))).catch((reason: unknown) => reason);
    if (!(error instanceof Error)) throw new Error("loadTarget accepted an egress host that names a service");
    expect(error.message.split("\n").filter((line) => line.startsWith("- "))).toEqual([
      "- egress host shop.example.test is the name or a network alias of a service",
      "- egress host api.example.test is the name or a network alias of a service",
    ]);
  });

  test("accept egress host names", async () => {
    const qa = { ...settings, egress: ["api.pwnedpasswords.com", "ai-gateway.vercel.sh", "xn--bcher-kva.example"] };
    const target = await load(await fixture("services:\n  web:\n    image: nginx:1.29-alpine\n", devcontainer({}, qa)));
    expect(target.settings.egress).toEqual(["api.pwnedpasswords.com", "ai-gateway.vercel.sh", "xn--bcher-kva.example"]);
  });

  const invalid: [string, Record<string, unknown>, string][] = [
    ["a URL that is not http or https", { ...settings, urls: { app: "ftp://web:21" } }, "must be an http: or https: URL"],
    ["no URLs", { ...settings, urls: {} }, "must name at least one URL"],
    ["a missing seed", { urls: settings.urls, ready: settings.ready }, "seed"],
    ["a misspelled key", { ...settings, offlimits: ["Do not delete teams."] }, "offlimits"],
    ["a hostEnv name the host does not set", { ...settings, hostEnv: ["QA_INTERNS_TEST_UNSET"] }, "hostEnv names QA_INTERNS_TEST_UNSET, which the environment of qa-interns does not set"],
    ["a secret variable that hostEnv does not name", { ...settings, hostEnv: ["PATH"], secrets: { hostEnv: ["HOME"] } }, "must name only variables that hostEnv names"],
    ["a misspelled secrets key", { ...settings, secrets: { seeds: ["password"] } }, "seeds"],
    ["a wildcard egress host", { ...settings, egress: ["*.vercel.sh"] }, "must be a lowercase host name"],
    ["an egress IP address", { ...settings, egress: ["203.0.113.7"] }, "must be a lowercase host name"],
    ["an egress IP address in short form", { ...settings, egress: ["169.16689662"] }, "must be a lowercase host name"],
    ["an egress IP address in hexadecimal", { ...settings, egress: ["0x7f.1"] }, "must be a lowercase host name"],
    ["an egress URL", { ...settings, egress: ["https://api.pwnedpasswords.com"] }, "must be a lowercase host name"],
    ["an uppercase egress host", { ...settings, egress: ["API.pwnedpasswords.com"] }, "must be a lowercase host name"],
    ["a single-label egress host", { ...settings, egress: ["localhost"] }, "must be a lowercase host name"],
    ["an egress host with a trailing dot", { ...settings, egress: ["api.pwnedpasswords.com."] }, "must be a lowercase host name"],
    ["an egress label that starts with a hyphen", { ...settings, egress: ["-api.pwnedpasswords.com"] }, "must be a lowercase host name"],
    ["an egress label that ends with a hyphen", { ...settings, egress: ["api-.pwnedpasswords.com"] }, "must be a lowercase host name"],
    ["an egress label longer than 63 characters", { ...settings, egress: [`${"a".repeat(64)}.example.com`] }, "must be a lowercase host name"],
    ["an egress host longer than 253 characters", { ...settings, egress: [`${"a".repeat(63)}.`.repeat(4) + "com"] }, "must be a lowercase host name"],
  ];

  test.each(invalid)("reject settings with %s", async (_, qa, message) => {
    const root = await fixture("services:\n  web:\n    image: nginx:1.29-alpine\n", devcontainer({}, qa));
    await expect(load(root)).rejects.toThrow(message);
  });
});

describe.skipIf(!dockerAvailable)("validate", () => {
  const cli = join(import.meta.dir, "..", "src", "cli.ts");
  const hostEnv = { ...settings, hostEnv: ["QA_INTERNS_TEST_KEY", "QA_INTERNS_TEST_DIR"] };

  async function validate(root: string, set: Record<string, string> = {}, options: string[] = []): Promise<{ code: number; stdout: string; stderr: string }> {
    const tmp = await scratch("qa-interns-validate-tmp-");
    const env = { ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("QA_INTERNS_TEST_"))), ...set, TMPDIR: tmp };
    const proc = Bun.spawn([process.execPath, cli, "validate", root, ...options], { env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    expect(await readdir(tmp)).toEqual([]);
    return { code, stdout, stderr };
  }

  test("pass the Ledger target", async () => {
    const root = await repo(await ledgerFiles(""));
    const passed = `${await realpath(root)} at ${git(root, "rev-parse", "HEAD")} passes the checks that run makes before it builds images.\n`;
    expect(await validate(root)).toEqual({ code: 0, stdout: passed, stderr: "" });
  });

  test("check the commit by default and the working tree with --dirty", async () => {
    const root = await fixture("services:\n  web:\n    image: nginx:1.29-alpine\n");
    await Bun.write(join(root, ".devcontainer", "compose.yml"), "services:\n  web:\n    image: nginx:1.29-alpine\n    container_name: shop-web\n");
    const head = git(root, "rev-parse", "HEAD");
    expect(await validate(root)).toEqual({ code: 0, stdout: `${await realpath(root)} at ${head} passes the checks that run makes before it builds images.\n`, stderr: "" });
    const dirty = await validate(root, {}, ["--dirty"]);
    expect(dirty.code).toBe(1);
    expect(dirty.stderr).toContain("- service web sets container_name shop-web");
    expect(await validate(root, {}, ["--dirty", "--commit", "HEAD"])).toEqual({ code: 1, stdout: "", stderr: "qa-interns: --dirty checks the working tree, so it takes no --commit\n" });
  });

  test("pass without the value of a hostEnv variable that secrets.hostEnv names", async () => {
    const compose = "services:\n  web:\n    image: nginx:1.29-alpine\n    environment:\n      API_KEY: ${QA_INTERNS_TEST_KEY:?set the API key}\n";
    const root = await fixture(compose, devcontainer({}, { ...settings, hostEnv: ["QA_INTERNS_TEST_KEY"], secrets: { hostEnv: ["QA_INTERNS_TEST_KEY"] } }));
    const result = await validate(root);
    expect(result).toMatchObject({ code: 0, stderr: "" });
    expect(result.stdout).toEndWith("hostEnv names QA_INTERNS_TEST_KEY, which the environment of qa-interns does not set. No checked setting depends on them.\n");
  });

  test("pass without the value of a hostEnv variable that only the environment of a service reads", async () => {
    const compose = "services:\n  web:\n    image: nginx:1.29-alpine\n    environment:\n      API_KEY: ${QA_INTERNS_TEST_KEY:?set the API key}\n";
    const root = await fixture(compose, devcontainer({}, { ...settings, hostEnv: ["QA_INTERNS_TEST_KEY"] }));
    expect(await validate(root)).toEqual({
      code: 0,
      stdout: `${await realpath(root)} at ${git(root, "rev-parse", "HEAD")} passes the checks that run makes before it builds images.\nhostEnv names QA_INTERNS_TEST_KEY, which the environment of qa-interns does not set. No checked setting depends on them.\n`,
      stderr: "",
    });
  });

  test("reject a checked setting that depends on an unset hostEnv variable through a parent directory, and check it with the value when it is set", async () => {
    const compose = 'services:\n  web:\n    image: nginx:1.29-alpine\n    environment:\n      API_KEY: ${QA_INTERNS_TEST_KEY}\n    volumes: ["${QA_INTERNS_TEST_DIR}/../data:/data"]\n';
    const root = await fixture(compose, devcontainer({}, hostEnv));
    expect(await validate(root)).toEqual({
      code: 1,
      stdout: "",
      stderr:
        'qa-interns: customizations["qa-interns"].hostEnv names QA_INTERNS_TEST_KEY, QA_INTERNS_TEST_DIR, which the environment of qa-interns does not set, and these checked settings depend on one or more of them:\n- volumes of service web\n',
    });
    const outside = await validate(root, { QA_INTERNS_TEST_DIR: "/etc/app" });
    expect(outside.code).toBe(1);
    expect(outside.stderr).toContain("- service web mounts /etc/app/../data, which resolves to /etc/data, outside the target directory");
  });

  test("reject a volume whose whole spec comes from an unset hostEnv variable", async () => {
    const root = await fixture('services:\n  web:\n    image: nginx:1.29-alpine\n    volumes: ["${QA_INTERNS_TEST_DIR}"]\n', devcontainer({}, { ...settings, hostEnv: ["QA_INTERNS_TEST_DIR"] }));
    expect(await validate(root)).toEqual({
      code: 1,
      stdout: "",
      stderr:
        'qa-interns: customizations["qa-interns"].hostEnv names QA_INTERNS_TEST_DIR, which the environment of qa-interns does not set, and these checked settings depend on one or more of them:\n- volumes of service web\n',
    });
    const socket = await validate(root, { QA_INTERNS_TEST_DIR: "/var/run/docker.sock:/var/run/docker.sock" });
    expect(socket.code).toBe(1);
    expect(socket.stderr).toContain("- service web mounts /var/run/docker.sock");
  });

  test("reject a checked setting that depends on an unset hostEnv variable in an included or extended file", async () => {
    const root = await repo({
      ".devcontainer/devcontainer.json": devcontainer({}, hostEnv),
      ".devcontainer/compose.yml": "include:\n  - sub/included.yml\nservices:\n  web:\n    extends:\n      file: sub/base.yml\n      service: base\n",
      ".devcontainer/sub/included.yml": 'services:\n  other:\n    image: nginx:1.29-alpine\n    volumes: ["${QA_INTERNS_TEST_DIR}/../data:/data"]\n',
      ".devcontainer/sub/base.yml": 'services:\n  base:\n    image: nginx:1.29-alpine\n    volumes: ["${QA_INTERNS_TEST_DIR}/../data:/data"]\n',
    });
    expect(await validate(root)).toEqual({
      code: 1,
      stdout: "",
      stderr:
        'qa-interns: customizations["qa-interns"].hostEnv names QA_INTERNS_TEST_KEY, QA_INTERNS_TEST_DIR, which the environment of qa-interns does not set, and these checked settings depend on one or more of them:\n- volumes of service other\n- volumes of service web\n',
    });
  });

  test("reject unsafe Compose settings while a hostEnv variable is unset", async () => {
    const compose = "services:\n  web:\n    image: nginx:1.29-alpine\n    container_name: shop-web\n    environment:\n      API_KEY: ${QA_INTERNS_TEST_KEY}\n";
    const result = await validate(await fixture(compose, devcontainer({}, hostEnv)));
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("- service web sets container_name shop-web");
  });

  test("reject a service whose image two built services produce", async () => {
    const compose = 'services:\n  web:\n    build: ..\n    image: qair-validate/app\n  api:\n    build:\n      context: ..\n      tags: ["qair-validate/app:latest"]\n  worker:\n    image: qair-validate/app\n';
    const result = await validate(await fixture(compose));
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("Services api and web both build the image qair-validate/app that service worker runs");
  });
});
