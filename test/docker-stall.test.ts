import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

let root = "";
const src = join(import.meta.dir, "..", "src");
const modules = `
  const { createDisk } = await import(${JSON.stringify(join(src, "environment.ts"))});
  const { ensureRunnerImage } = await import(${JSON.stringify(join(src, "runner.ts"))});
  const { abortable, capture, killCommands } = await import(${JSON.stringify(join(src, "target.ts"))});
  const abortAfter = (ms) => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), ms);
    return controller.signal;
  };
  const started = Date.now();
  const report = (error) => console.log(JSON.stringify({ seconds: (Date.now() - started) / 1000, error: error === null ? null : String(error) }));
`;

const stalledDocker = `#!/bin/sh
case "$1 $2" in
  "volume inspect" | "image inspect") exit 1 ;;
  "volume create" | "volume rm") exit 0 ;;
esac
case "$1" in
  run | rm) exec sleep 600 ;;
  build)
    trap '' TERM
    sleep 600 &
    exec sleep 600
    ;;
esac
exit 0
`;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "qa-interns-stall-"));
  await mkdir(join(root, "bin"));
  await mkdir(join(root, "out"));
  await writeFile(join(root, "bin", "docker"), stalledDocker);
  await chmod(join(root, "bin", "docker"), 0o755);
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

async function stalled(body: string): Promise<{ seconds: number; error: string | null }> {
  const child = Bun.spawn([process.execPath, "-e", `${modules}\n${body}`], { env: { ...process.env, PATH: `${join(root, "bin")}:${process.env.PATH}` }, stdout: "pipe", stderr: "inherit" });
  const [stdout, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
  expect(code).toBe(0);
  return JSON.parse(stdout.trim());
}

const disk = (owner: string) => `createDisk(${JSON.stringify(join(root, "out"))}, "image", ${JSON.stringify(owner)})`;

test(
  "a deadline that stops an output disk's docker run ends the disk's rollback within seconds when docker stalls removing it",
  async () => {
    const result = await stalled(`report(await abortable(abortAfter(500), () => ${disk("qair-t-rollback")}).then(() => null, (error) => error));`);
    expect(result.error).toContain("docker rm -f qair-t-rollback");
    expect(result.error).toContain("timed out after 5 seconds");
    expect(result.seconds).toBeLessThan(20);
  },
  60_000,
);

test(
  "the run's end stops an output disk's rollback that a stalled docker holds, before the rollback's own timeout",
  async () => {
    const result = await stalled(`report(await abortable(abortAfter(500), () => ${disk("qair-t-end")}, abortAfter(1500)).then(() => null, (error) => error));`);
    expect(result.error).not.toBeNull();
    expect(result.error).not.toContain("timed out");
    expect(result.seconds).toBeLessThan(4);
  },
  60_000,
);

test(
  "a deadline stops a runner image build whose processes ignore SIGTERM and hold its output open",
  async () => {
    const result = await stalled("report(await abortable(abortAfter(500), ensureRunnerImage).then(() => null, (error) => error));");
    expect(result.error).not.toBeNull();
    expect(result.seconds).toBeGreaterThan(9);
    expect(result.seconds).toBeLessThan(20);
  },
  60_000,
);

test(
  "an interrupt kills a command that ignores SIGTERM ten seconds later",
  async () => {
    const result = await stalled(`
      setTimeout(killCommands, 300);
      const { code } = await capture(["sh", "-c", "trap '' TERM; exec sleep 600"]);
      report(code === 137 ? null : new Error("exit " + code));
    `);
    expect(result.error).toBeNull();
    expect(result.seconds).toBeGreaterThan(9);
    expect(result.seconds).toBeLessThan(20);
  },
  60_000,
);

test(
  "an interrupt kills a command's child that ignores SIGTERM after the command itself exits",
  async () => {
    const result = await stalled(`
      setTimeout(killCommands, 300);
      await abortable(new AbortController().signal, () => capture(["sh", "-c", "(trap '' TERM; exec sleep 600) & wait"]));
      report(null);
    `);
    expect(result.error).toBeNull();
    expect(result.seconds).toBeGreaterThan(9);
    expect(result.seconds).toBeLessThan(20);
  },
  60_000,
);
