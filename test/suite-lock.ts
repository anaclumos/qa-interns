import { mkdirSync, readdirSync, readlinkSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { errorCode } from "../src/findings.ts";
import { flock } from "../src/logins.ts";
import { execute } from "../src/target.ts";

const runtime = process.env.XDG_RUNTIME_DIR;
if (runtime === undefined || runtime === "") throw new Error("XDG_RUNTIME_DIR is not set, and the test suite keeps its lock there");
const dir = join(runtime, "qa-interns");
mkdirSync(dir, { recursive: true, mode: 0o700 });
const file = join(realpathSync(dir), "suite.lock");
export const suiteLabel = `qa-interns.suite=${file}`;

async function labeled(...list: string[]): Promise<string[]> {
  return (await execute(["docker", ...list, "-q", "--filter", `label=${suiteLabel}`])).split("\n").filter((id) => id !== "");
}

function opened(fd: string): string | null {
  try {
    return readlinkSync(join("/proc/self/fd", fd));
  } catch (error) {
    if (errorCode(error) === "ENOENT") return null;
    throw error;
  }
}

if (!readdirSync("/proc/self/fd").some((fd) => opened(fd) === file)) {
  if (flock(file, "--exclusive", "--nonblock") === null) {
    console.error(`Waiting for the test suite that holds ${file} to end`);
    flock(file, "--exclusive");
  }
  if (Bun.spawnSync(["docker", "info"], { stdout: "ignore", stderr: "ignore" }).exitCode === 0) {
    const containers = await labeled("ps", "-a");
    if (containers.length > 0) await execute(["docker", "rm", "-f", ...containers]);
    const networks = await labeled("network", "ls");
    if (networks.length > 0) await execute(["docker", "network", "rm", ...networks]);
  }
}
