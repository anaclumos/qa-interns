import { userInfo } from "node:os";
import { join } from "node:path";

const runnerDir = join(import.meta.dir, "..", "runner");

export async function runnerImage(): Promise<string> {
  const { uid, gid } = userInfo();
  const files = await Promise.all(["Dockerfile", "proxy.mjs"].map((name) => Bun.file(join(runnerDir, name)).text()));
  const hash = new Bun.CryptoHasher("sha256").update(JSON.stringify([...files, uid, gid])).digest("hex");
  return `qa-interns-runner:${hash.slice(0, 12)}`;
}

export async function ensureRunnerImage(): Promise<string> {
  const image = await runnerImage();
  const inspect = Bun.spawn(["docker", "image", "inspect", image], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
  if ((await inspect.exited) === 0) return image;
  const { uid, gid } = userInfo();
  const cmd = ["docker", "build", "--build-arg", `QA_UID=${uid}`, "--build-arg", `QA_GID=${gid}`, "-t", image, runnerDir];
  const build = Bun.spawn(cmd, { stdin: "ignore", stdout: 2, stderr: "pipe" });
  let tail = "";
  const decoder = new TextDecoder();
  for await (const chunk of build.stderr) {
    process.stderr.write(chunk);
    tail = (tail + decoder.decode(chunk, { stream: true })).slice(-2000);
  }
  const code = await build.exited;
  if (code !== 0) throw new Error(`${cmd.join(" ")} exited with ${code}: ${tail.trim()}`);
  return image;
}
