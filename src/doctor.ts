import { mkdtemp, rm } from "node:fs/promises";
import { arch, freemem, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { environmentMemory, freeSlot, slotSubnets } from "./environment.ts";
import { loadLogins, Scheduler } from "./logins.ts";
import { ensureRunnerImage } from "./runner.ts";
import { execute } from "./target.ts";

const devcontainer = join(dirname(fileURLToPath(import.meta.resolve("@devcontainers/cli/package.json"))), "devcontainer.js");
const gib = 1024 ** 3;
const agents = [
  ["claude-agent-acp", "--version"],
  ["codex-acp", "--version"],
  ["cursor-agent", "--version"],
  ["grok", "--version"],
  ["agent-browser", "--version"],
];

const versionSchema = z.object({ Client: z.object({ Version: z.string() }), Server: z.object({ Version: z.string() }) });
const composeSchema = z.object({
  services: z.object({ app: z.object({ ports: z.array(z.unknown()).optional(), networks: z.record(z.string(), z.unknown()).optional() }) }),
});

const baseCompose = `services:
  app:
    image: busybox
    ports: ["8080:80"]
    networks: [first]
networks:
  first: {}
  second: {}
`;

const overrideCompose = `services:
  app:
    ports: !reset []
    networks: !override [second]
`;

function firstLine(text: string): string {
  return text.trim().split("\n")[0] ?? "";
}

async function checkCompose(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "qa-interns-doctor-"));
  try {
    await Bun.write(join(dir, "base.yml"), baseCompose);
    await Bun.write(join(dir, "override.yml"), overrideCompose);
    const cmd = ["docker", "compose", "-p", `qa-interns-doctor-${process.pid}`, "-f", join(dir, "base.yml"), "-f", join(dir, "override.yml")];
    const { app } = composeSchema.parse(JSON.parse(await execute([...cmd, "config", "--format", "json"]))).services;
    if ((app.ports ?? []).length > 0) throw new Error(`!reset [] left ports ${JSON.stringify(app.ports)}`);
    const networks = Object.keys(app.networks ?? {});
    if (networks.join(",") !== "second") throw new Error(`!override [second] gave networks ${JSON.stringify(networks)}`);
    const version = (await execute(["docker", "compose", "version", "--short"])).trim();
    return `Compose ${version} applies !reset and !override`;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function checkNetwork(): Promise<string> {
  const name = `qa-interns-doctor-${process.pid}`;
  const reserved = new Set<number>();
  const subnet = slotSubnets(await freeSlot(reserved)).internal;
  await execute(["docker", "network", "create", "--internal", "--subnet", subnet, "-o", "com.docker.network.bridge.gateway_mode_ipv4=isolated", name]);
  await execute(["docker", "network", "rm", name]);
  return `created and removed ${name} on ${subnet}`;
}

export async function doctor(loginsFile: string, print: (line: string) => void): Promise<boolean> {
  let passed = true;
  const check = async (name: string, run: () => Promise<string>): Promise<void> => {
    try {
      print(`ok ${name}: ${await run()}`);
    } catch (error) {
      passed = false;
      const text = error instanceof Error ? error.message : String(error);
      print(`fail ${name}: ${text.replaceAll("\r", " ").replaceAll("\n", " ").slice(0, 500)}`);
    }
  };

  await check("cpu", async () => {
    if (arch() !== "x64") throw new Error(`the CPU is ${arch()}, and the runner image needs x86-64`);
    return "x86-64";
  });
  await check("docker", async () => {
    const version = versionSchema.parse(JSON.parse(await execute(["docker", "version", "--format", "json"])));
    return `client ${version.Client.Version}, server ${version.Server.Version}`;
  });
  await check("compose", checkCompose);
  await check("isolated network", checkNetwork);
  await check("dev container cli", async () => `version ${(await execute([process.execPath, devcontainer, "--version"])).trim()}`);
  await check("git", async () => (await execute(["git", "--version"])).trim());
  let image: string | null = null;
  await check("runner image", async () => {
    image = await ensureRunnerImage();
    return image;
  });
  for (const argv of agents) {
    await check(`runner ${argv.join(" ")}`, async () => {
      if (image === null) throw new Error("the runner image is not available");
      return firstLine(await execute(["docker", "run", "--rm", "--network", "none", image, ...argv]));
    });
  }
  await check("logins", async () => {
    const logins = await loadLogins(loginsFile);
    const scheduler = new Scheduler(logins);
    return `${loginsFile}: ${logins.length} ${logins.length === 1 ? "login" : "logins"}, providers ${scheduler.providers().join(", ")}, capacity ${scheduler.capacity()}`;
  });
  await check("memory", async () => {
    const free = freemem();
    const base = environmentMemory(null);
    const summary = `${(free / gib).toFixed(1)} GiB free; an environment reserves ${(base / gib).toFixed(1)} GiB for its runner and proxy plus each service's mem_limit (1 GiB when unset)`;
    if (free < base) throw new Error(summary);
    return summary;
  });
  return passed;
}
