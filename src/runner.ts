import { join } from "node:path";
import { capture, execute, track } from "./target.ts";

const runnerDir = join(import.meta.dir, "..", "runner");

export const qaUser = { uid: 1000, gid: 1000 };

export async function runnerImage(): Promise<string> {
  const files = await Promise.all(["Dockerfile", "package.json", "package-lock.json", "proxy.mjs", "relay.mjs", "agent-browser"].map((name) => Bun.file(join(runnerDir, name)).text()));
  const hash = new Bun.CryptoHasher("sha256").update(JSON.stringify(files)).digest("hex");
  return `qa-interns-runner:${hash.slice(0, 12)}`;
}

export async function ensureRunnerImage(): Promise<string> {
  const image = await runnerImage();
  if ((await capture(["docker", "image", "inspect", image])).code === 0) return image;
  const cmd = ["docker", "build", "-t", image, runnerDir];
  const build = track(Bun.spawn(cmd, { stdin: "ignore", stdout: 2, stderr: "pipe" }));
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

export async function browserVersion(image: string): Promise<string> {
  const version = (await execute(["docker", "run", "--rm", "--network", "none", "--entrypoint", "chrome", image, "--version"], { timeout: 60_000 })).trim();
  if (version === "") throw new Error(`chrome --version in ${image} printed nothing`);
  return version;
}
