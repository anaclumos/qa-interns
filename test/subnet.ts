import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { freeSlots } from "../src/environment.ts";
import { flock } from "../src/logins.ts";

const runtime = process.env.XDG_RUNTIME_DIR;
if (runtime === undefined || runtime === "") throw new Error("XDG_RUNTIME_DIR is not set, and the tests keep the locks of their network blocks there");
const locks = join(runtime, "qa-interns", "blocks");
mkdirSync(locks, { recursive: true, mode: 0o700 });

export async function freeBlock(second: number): Promise<number> {
  const previous = process.env.QA_INTERNS_SUBNET;
  const start = Math.floor(Math.random() * 64);
  try {
    for (let step = 0; step < 64; step++) {
      const third = 4 * ((start + step) % 64);
      process.env.QA_INTERNS_SUBNET = `10.${second}.${third}.0/22`;
      if ((await freeSlots()) === 2 && flock(join(locks, `10.${second}.${third}.0.lock`), "--exclusive", "--nonblock") !== null) return third;
    }
  } finally {
    if (previous === undefined) delete process.env.QA_INTERNS_SUBNET;
    else process.env.QA_INTERNS_SUBNET = previous;
  }
  throw new Error(`Every /22 block of 10.${second}.0.0/16 overlaps a Docker network or a host route, or is held by another test process`);
}
