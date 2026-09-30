import { freeSlots } from "../src/environment.ts";

export async function freeBlock(second: number): Promise<number> {
  const previous = process.env.QA_INTERNS_SUBNET;
  const start = Math.floor(Math.random() * 64);
  try {
    for (let step = 0; step < 64; step++) {
      const third = 4 * ((start + step) % 64);
      process.env.QA_INTERNS_SUBNET = `10.${second}.${third}.0/22`;
      if ((await freeSlots()) === 2) return third;
    }
  } finally {
    if (previous === undefined) delete process.env.QA_INTERNS_SUBNET;
    else process.env.QA_INTERNS_SUBNET = previous;
  }
  throw new Error(`Every /22 block of 10.${second}.0.0/16 overlaps a Docker network or a host route`);
}
