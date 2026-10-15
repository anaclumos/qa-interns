import { afterAll, beforeAll, expect, test } from "bun:test";
import { closeSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { flock } from "../src/logins.ts";

let root = "";
const environment = join(import.meta.dir, "..", "src", "environment.ts");
const long = `web${"a".repeat(117)}`;
const config = { services: { web: { build: { context: ".." } }, api: { build: { context: ".." }, platform: "linux/arm64/v8" }, [long]: { build: { context: ".." } } } };

const recordingDocker = (dir: string) => `#!/bin/sh
echo "$*" >> ${dir}/calls
case "$1 $2" in
  "version --format") echo linux/amd64; exit 0 ;;
  "push --quiet") case "$3" in *:qa-api-*) echo "denied: permission_denied: write_package" >&2; exit 1 ;; esac; exit 0 ;;
esac
case " $* " in
  *" config "*) echo '${JSON.stringify(config)}' ;;
  *" build "*)
    for arg; do [ "$previous" = -f ] && file=$arg; previous=$arg; done
    cp "$file" ${dir}/tags.yml
    ;;
esac
exit 0
`;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "qa-interns-cache-"));
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

function pushLock(ref: string): string {
  return join(process.env.XDG_RUNTIME_DIR ?? "", "qa-interns", "cache", `${new Bun.CryptoHasher("sha256").update(ref).digest("hex")}.lock`);
}

async function build(name: string, cache: string | null): Promise<{ calls: string[]; tags: string; log: string }> {
  const dir = join(root, name);
  await mkdir(join(dir, "bin"), { recursive: true });
  await mkdir(join(dir, "source", ".devcontainer"), { recursive: true });
  await writeFile(join(dir, "bin", "docker"), recordingDocker(dir));
  await chmod(join(dir, "bin", "docker"), 0o755);
  const service = { build: true, image: null, tags: [], active: true };
  const target = {
    repo: dir,
    path: ".",
    commit: "0".repeat(40),
    dirty: false,
    settings: { hostEnv: [], secrets: { hostEnv: [], seed: [] } },
    composeFiles: ["compose.yml"],
    services: { web: service, api: service, [long]: service },
  };
  const body = `
    const { buildImages } = await import(${JSON.stringify(environment)});
    await buildImages(${JSON.stringify(name)}, ${JSON.stringify(target)}, ${JSON.stringify(join(dir, "source"))}, ${JSON.stringify(join(dir, "build.log"))}, ${JSON.stringify(cache)});
  `;
  const child = Bun.spawn([process.execPath, "-e", body], { env: { ...process.env, PATH: `${join(dir, "bin")}:${process.env.PATH}` }, stdout: "inherit", stderr: "inherit" });
  expect(await child.exited).toBe(0);
  const read = (file: string) => readFile(join(dir, file), "utf8");
  return { calls: (await read("calls")).trim().split("\n"), tags: await read("tags.yml"), log: await read("build.log") };
}

test("build with no registry cache, and push nothing, when no cache repository is given", async () => {
  const { calls, tags } = await build("nocache", null);
  expect(calls.at(-1)).toEndWith(` build web api ${long}`);
  expect(calls.filter((call) => /^(version|tag|push|buildx) /.test(call))).toEqual([]);
  expect(tags).not.toContain("cache_");
});

test("read each service's cache from its image tag for its platform, then push the built image with its inline cache to that tag, and only log a refused push", async () => {
  const { calls, tags, log } = await build("cache", "ghcr.io/owner/app-qa-cache");
  const full = `qa-${long}-linux-amd64`;
  const bounded = `${full.slice(0, 115)}-${new Bun.CryptoHasher("sha256").update(full).digest("hex").slice(0, 12)}`;
  expect(bounded).toHaveLength(128);
  const refs = { web: "ghcr.io/owner/app-qa-cache:qa-web-linux-amd64", api: "ghcr.io/owner/app-qa-cache:qa-api-linux-arm64-v8", [long]: `ghcr.io/owner/app-qa-cache:${bounded}` };
  for (const ref of Object.values(refs)) expect(tags).toContain(`      cache_from: ${JSON.stringify([ref])}\n      cache_to: ["type=inline"]\n`);
  const built = calls.findIndex((call) => call.endsWith(` build web api ${long}`));
  expect(built).toBeGreaterThan(-1);
  expect(calls.slice(built + 1)).toEqual(
    Object.entries(refs).flatMap(([service, ref]) => [`tag qa-cache-${service.toLowerCase()}:latest ${ref}`, `push --quiet ${ref}`, `image rm ${ref}`]),
  );
  expect(log).toContain(`The build cache was not written, so the next build does not read this one: docker push ${refs.api} exited with 1: denied: permission_denied: write_package`);
  expect(log).not.toContain(refs.web);
});

test("leave a cache reference alone, with its tag and push, while another run pushes it under any name for the same reference", async () => {
  const ref = "docker.io/owner/held-qa-cache:qa-web-linux-amd64";
  await mkdir(dirname(pushLock(ref)), { recursive: true });
  const fd = flock(pushLock(ref), "exclusive", "block");
  try {
    const { calls, log } = await build("held", "owner/held-qa-cache");
    expect(calls.filter((call) => call.endsWith(" owner/held-qa-cache:qa-web-linux-amd64"))).toEqual([]);
    expect(calls).toContain("push --quiet owner/held-qa-cache:qa-api-linux-arm64-v8");
    expect(log).toContain("The build cache was not written, so the next build does not read this one: another run is pushing owner/held-qa-cache:qa-web-linux-amd64");
  } finally {
    closeSync(fd);
  }
});
