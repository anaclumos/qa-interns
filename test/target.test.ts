import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  const ref = await resolveTarget(root, "HEAD");
  const source = await scratch("qa-interns-source-");
  await exportTree(ref, source);
  return loadTarget(ref, source);
}

describe("resolveTarget and exportTree", () => {
  test("resolve a subdirectory to the repository, its path, and the commit, and export only that tree", async () => {
    const root = await repo({ ...(await ledgerFiles("apps/ledger/")), "README.md": "monorepo\n", "apps/other/index.ts": "export {};\n" });
    const head = git(root, "rev-parse", "HEAD");
    const ref = await resolveTarget(join(root, "apps", "ledger"), "HEAD");
    expect(ref).toEqual({ repo: await realpath(root), path: "apps/ledger", commit: head });

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

    const older = await resolveTarget(join(root, "app"), "HEAD~1");
    expect(older.commit).toBe(first);
    const olderDest = await scratch("qa-interns-export-");
    await exportTree(older, olderDest);
    expect(await Bun.file(join(olderDest, "VERSION")).text()).toBe("one\n");

    const head = await resolveTarget(join(root, "app"), "HEAD");
    const headDest = await scratch("qa-interns-export-");
    await exportTree(head, headDest);
    expect(await Bun.file(join(headDest, "VERSION")).text()).toBe("two\n");
    expect(await Bun.file(join(headDest, "untracked.txt")).exists()).toBe(false);
  });

  test("resolve the repository root to an empty path and export the whole tree", async () => {
    const root = await repo({ "app.ts": "export {};\n", ".devcontainer/devcontainer.json": devcontainer() });
    const ref = await resolveTarget(root, "HEAD");
    expect(ref.path).toBe("");
    const dest = await scratch("qa-interns-export-");
    await exportTree(ref, dest);
    expect((await readdir(dest)).sort()).toEqual([".devcontainer", "app.ts"]);
  });

  test("reject a revision that does not exist", async () => {
    const root = await repo({ "app.ts": "export {};\n" });
    await expect(resolveTarget(root, "no-such-branch")).rejects.toThrow("no-such-branch^{commit}");
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
      hostEnv: [],
    });
    expect(target.composeFiles).toEqual(["compose.yml"]);
    expect(target.service).toBe("web");
    expect(target.config.workspaceFolder).toBe("/app");
    expect(target.services).toEqual({
      web: { build: true, image: null, memLimit: null, networkMode: null, aliases: [], hasCpus: false, hasPidsLimit: false, deployLimits: false, active: true, replicas: 1 },
      db: { build: false, image: "postgres:17.11-alpine", memLimit: null, networkMode: null, aliases: [], hasCpus: false, hasPidsLimit: false, deployLimits: false, active: true, replicas: 1 },
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
      web: { build: false, image: "nginx:1.29-alpine", memLimit: 536870912, networkMode: null, aliases: [], hasCpus: true, hasPidsLimit: true, deployLimits: false, active: true, replicas: 1 },
      sidecar: { build: false, image: "busybox:1.37", memLimit: null, networkMode: "service:web", aliases: [], hasCpus: false, hasPidsLimit: false, deployLimits: false, active: true, replicas: 1 },
      worker: { build: true, image: null, memLimit: 268435456, networkMode: null, aliases: [], hasCpus: true, hasPidsLimit: true, deployLimits: true, active: true, replicas: 1 },
      mailer: { build: false, image: "axllent/mailpit:v1.27", memLimit: null, networkMode: null, aliases: [], hasCpus: false, hasPidsLimit: false, deployLimits: false, active: false, replicas: 1 },
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

  test("treat a required dependency behind a profile as active and an optional one as inactive", async () => {
    const compose = `services:
  web:
    image: nginx:1.29-alpine
    depends_on:
      cache:
        condition: service_started
      tracing:
        condition: service_started
        required: false
  cache:
    image: redis:8.2-alpine
    profiles: ["cache"]
  tracing:
    image: jaegertracing/jaeger:2.9.0
    profiles: ["tracing"]
  mailer:
    image: axllent/mailpit:v1.27
    profiles: ["mail"]
`;
    const target = await load(await fixture(compose, devcontainer({})));
    expect(Object.fromEntries(Object.entries(target.services).map(([name, service]) => [name, service.active]))).toEqual({
      web: true,
      cache: true,
      tracing: false,
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

  test("reject a bind mount through a symbolic link in the target that points outside it", async () => {
    const root = await fixture("services:\n  web:\n    image: nginx:1.29-alpine\n    volumes: [\"../host:/host\"]\n");
    await symlink("/etc", join(root, "host"));
    git(root, "add", "-A");
    git(root, "commit", "-q", "-m", "link");
    await expect(load(root)).rejects.toThrow("/host, which resolves to /etc, outside the target directory");
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
      hostEnv: [],
    });
  });

  const invalid: [string, Record<string, unknown>, string][] = [
    ["a URL that is not http or https", { ...settings, urls: { app: "ftp://web:21" } }, "must be an http: or https: URL"],
    ["no URLs", { ...settings, urls: {} }, "must name at least one URL"],
    ["a missing seed", { urls: settings.urls, ready: settings.ready }, "seed"],
    ["a misspelled key", { ...settings, offlimits: ["Do not delete teams."] }, "offlimits"],
    ["a hostEnv name the host does not set", { ...settings, hostEnv: ["QA_INTERNS_TEST_UNSET"] }, "hostEnv names QA_INTERNS_TEST_UNSET, which the environment of qa-interns does not set"],
  ];

  test.each(invalid)("reject settings with %s", async (_, qa, message) => {
    const root = await fixture("services:\n  web:\n    image: nginx:1.29-alpine\n", devcontainer({}, qa));
    await expect(load(root)).rejects.toThrow(message);
  });
});
