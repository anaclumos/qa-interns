import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { arch, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";
import { createDisk, devcontainer, freeSlot, memoryPeak, removeDir, saveDisk, slotSubnets } from "./environment.ts";
import { message, oneLine } from "./findings.ts";
import { loadLogins, Scheduler } from "./logins.ts";
import { ensureRunnerImage } from "./runner.ts";
import { runsDir } from "./state.ts";
import { composeVersion, execute } from "./target.ts";

const agents = [
  ["claude-agent-acp", "--version"],
  ["codex-acp", "--version"],
  ["cursor-agent", "--version"],
  ["grok", "--version"],
  ["opencode", "--version"],
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
    return `Compose ${await composeVersion()} applies !reset and !override`;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function checkDisk(image: string): Promise<string> {
  const state = dirname(runsDir());
  await mkdir(state, { recursive: true });
  const dir = await mkdtemp(join(state, "doctor-"));
  const owner = `qa-interns-doctor-${process.pid}`;
  try {
    const out = join(dir, "out");
    await mkdir(out);
    try {
      await createDisk(out, image, owner);
      await Bun.write(join(out, "check.txt"), "saved\n");
    } finally {
      await saveDisk(out, image, owner);
    }
    const saved = await Bun.file(join(out, "check.txt")).text();
    if (saved !== "saved\n") throw new Error(`the saved disk holds ${JSON.stringify(saved)} instead of the file written to it`);
    return `created, mounted, and saved an output disk in ${state}`;
  } finally {
    await removeDir(dir, image, owner);
  }
}

async function checkMemoryPeak(image: string): Promise<string> {
  const id = (await execute(["docker", "run", "-d", "--name", `qa-interns-doctor-${process.pid}-memory`, "--network", "none", image, "sleep", "60"])).trim();
  try {
    const pid = Number((await execute(["docker", "inspect", "--type", "container", "--format", "{{.State.Pid}}", id])).trim());
    const peak = await memoryPeak(id, pid);
    if (peak === null) throw new Error(`the peak memory of running container ${id} is not readable from /proc/${pid}/cgroup and /sys/fs/cgroup`);
    return `read a peak of ${(peak / 1024 ** 2).toFixed(1)} MiB from the cgroup of a running container`;
  } finally {
    await execute(["docker", "rm", "-f", id]);
  }
}

async function checkNetwork(): Promise<string> {
  const name = `qa-interns-doctor-${process.pid}`;
  const slot = await freeSlot();
  try {
    const subnet = slotSubnets(slot.slot).internal;
    await execute(["docker", "network", "create", "--internal", "--subnet", subnet, "-o", "com.docker.network.bridge.gateway_mode_ipv4=isolated", name]);
    await execute(["docker", "network", "rm", name]);
    return `created and removed ${name} on ${subnet}`;
  } finally {
    slot.release();
  }
}

export async function doctor(loginsFile: string, print: (line: string) => void): Promise<boolean> {
  let passed = true;
  const check = async (name: string, run: () => Promise<string>): Promise<void> => {
    try {
      print(`ok ${name}: ${await run()}`);
    } catch (error) {
      passed = false;
      print(`fail ${name}: ${oneLine(message(error)).slice(0, 500)}`);
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
  await check("findmnt", async () => (await execute(["findmnt", "--version"])).trim());
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
  await check("output disk", async () => {
    if (image === null) throw new Error("the runner image is not available");
    return checkDisk(image);
  });
  await check("peak memory", async () => {
    if (image === null) throw new Error("the runner image is not available");
    return checkMemoryPeak(image);
  });
  await check("logins", async () => {
    const logins = await loadLogins(loginsFile);
    const scheduler = new Scheduler(logins);
    return `${loginsFile}: ${logins.length} ${logins.length === 1 ? "login" : "logins"}, providers ${scheduler.providers().join(", ")}, capacity ${scheduler.capacity()}`;
  });
  return passed;
}
