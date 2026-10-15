import { afterAll, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dirs: string[] = [];

afterAll(async () => {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});

const stalledDocker = `#!/bin/sh
case "$1 $2" in
  "volume inspect") exit 1 ;;
  "volume create" | "volume rm") exit 0 ;;
esac
case "$1" in
  run | rm) exec sleep 600 ;;
esac
exit 0
`;

test(
  "a deadline that stops an output disk's docker run ends the disk's rollback within seconds when docker stalls removing it",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "qa-interns-rollback-"));
    dirs.push(root);
    const bin = join(root, "bin");
    const out = join(root, "out");
    await mkdir(bin);
    await mkdir(out);
    await writeFile(join(bin, "docker"), stalledDocker);
    await chmod(join(bin, "docker"), 0o755);
    const src = join(import.meta.dir, "..", "src");
    const script = `
      const { createDisk } = await import(${JSON.stringify(join(src, "environment.ts"))});
      const { abortable } = await import(${JSON.stringify(join(src, "target.ts"))});
      const controller = new AbortController();
      setTimeout(() => controller.abort(), 500);
      const started = Date.now();
      const error = await abortable(controller.signal, () => createDisk(${JSON.stringify(out)}, "image", "qair-t-rollback")).then(() => null, (reason) => reason);
      console.log(JSON.stringify({ seconds: (Date.now() - started) / 1000, error: error === null ? null : String(error) }));
    `;
    const child = Bun.spawn([process.execPath, "-e", script], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}` }, stdout: "pipe", stderr: "inherit" });
    const [stdout, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
    expect(code).toBe(0);
    const result = JSON.parse(stdout.trim()) as { seconds: number; error: string | null };
    expect(result.error).toContain("docker rm -f qair-t-rollback");
    expect(result.error).toContain("timed out after 5 seconds");
    expect(result.seconds).toBeLessThan(20);
  },
  60_000,
);
