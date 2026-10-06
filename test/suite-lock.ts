import { mkdirSync, readdirSync, readFileSync, readlinkSync, realpathSync } from "node:fs";
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

function opened(pid: number, fd: string): string | null {
  try {
    return readlinkSync(join("/proc", String(pid), "fd", fd));
  } catch (error) {
    if (errorCode(error) === "ENOENT") return null;
    throw error;
  }
}

function parent(pid: number): number {
  const line = readFileSync(join("/proc", String(pid), "status"), "utf8")
    .split("\n")
    .find((entry) => entry.startsWith("PPid:"));
  if (line === undefined) throw new Error(`/proc/${pid}/status has no PPid line`);
  return Number(line.slice("PPid:".length));
}

function holds(pid: number): boolean {
  try {
    return readdirSync(join("/proc", String(pid), "fd")).some((fd) => opened(pid, fd) === file);
  } catch (error) {
    if (errorCode(error) === "EACCES") return false;
    throw error;
  }
}

function held(): boolean {
  for (let pid = process.pid; pid > 0; pid = parent(pid)) if (holds(pid)) return true;
  return false;
}

async function take(): Promise<number> {
  let fd = flock(file, "exclusive", "nonblock");
  if (fd === null) {
    console.error(`Waiting for the test suite that holds ${file} to end`);
    fd = flock(file, "exclusive", "block");
    if (fd === null) throw new Error(`flock on ${file} reported the lock as held after it waited for it`);
  }
  if (Bun.spawnSync(["docker", "info"], { stdout: "ignore", stderr: "ignore" }).exitCode === 0) {
    const containers = await labeled("ps", "-a");
    if (containers.length > 0) await execute(["docker", "rm", "-f", ...containers]);
    const networks = await labeled("network", "ls");
    if (networks.length > 0) await execute(["docker", "network", "rm", ...networks]);
  }
  return fd;
}

if (import.meta.main) {
  const fd = held() ? null : await take();
  const command = Bun.spawn(process.argv.slice(2), { stdio: ["inherit", "inherit", "inherit", ...(fd === null ? [] : [fd])] });
  process.exit(await command.exited);
} else if (process.env.BUN_TEST_WORKER_ID !== undefined) {
  if (!held()) throw new Error(`bun test --parallel runs each test file in a worker process, and no process above this worker holds ${file}. Run bun run test, which takes the lock and then starts bun test --parallel.`);
} else if (!held()) await take();
