import { mkdirSync, readdirSync, readlinkSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { errorCode } from "../src/findings.ts";
import { flock } from "../src/logins.ts";

const runtime = process.env.XDG_RUNTIME_DIR;
if (runtime === undefined || runtime === "") throw new Error("XDG_RUNTIME_DIR is not set, and the test suite keeps its lock there");
const dir = join(runtime, "qa-interns");
mkdirSync(dir, { recursive: true, mode: 0o700 });
const file = join(realpathSync(dir), "suite.lock");

function opened(fd: string): string | null {
  try {
    return readlinkSync(join("/proc/self/fd", fd));
  } catch (error) {
    if (errorCode(error) === "ENOENT") return null;
    throw error;
  }
}

if (!readdirSync("/proc/self/fd").some((fd) => opened(fd) === file) && flock(file, "--exclusive", "--nonblock") === null) {
  console.error(`Waiting for the test suite that holds ${file} to end`);
  flock(file, "--exclusive");
}
