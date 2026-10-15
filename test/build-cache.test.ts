import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

let root = "";
const environment = join(import.meta.dir, "..", "src", "environment.ts");
const config = { services: { web: { build: { context: ".." } }, api: { build: { context: ".." }, platform: "linux/arm64/v8" } } };

const recordingDocker = (dir: string) => `#!/bin/sh
echo "$* BUILDX_BUILDER=\${BUILDX_BUILDER-}" >> ${dir}/calls
case "$1 $2" in
  "buildx inspect") [ -e ${dir}/builder ] && exit 0; exit 1 ;;
  "buildx create") touch ${dir}/builder; exit 0 ;;
  "version --format") echo linux/amd64; exit 0 ;;
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

async function build(name: string, cache: string | null): Promise<{ calls: string[]; tags: string }> {
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
    services: { web: service, api: service },
  };
  const body = `
    const { buildImages } = await import(${JSON.stringify(environment)});
    await buildImages(${JSON.stringify(name)}, ${JSON.stringify(target)}, ${JSON.stringify(join(dir, "source"))}, ${JSON.stringify(join(dir, "build.log"))}, ${JSON.stringify(cache)});
  `;
  const child = Bun.spawn([process.execPath, "-e", body], { env: { ...process.env, PATH: `${join(dir, "bin")}:${process.env.PATH}` }, stdout: "inherit", stderr: "inherit" });
  expect(await child.exited).toBe(0);
  return { calls: (await readFile(join(dir, "calls"), "utf8")).trim().split("\n"), tags: await readFile(join(dir, "tags.yml"), "utf8") };
}

test("build with no registry cache, on the default builder, when no cache repository is given", async () => {
  const { calls, tags } = await build("nocache", null);
  expect(calls.filter((call) => call.startsWith("buildx") || call.startsWith("version"))).toEqual([]);
  expect(calls.at(-1)).toEndWith(" build web api BUILDX_BUILDER=");
  expect(tags).not.toContain("cache_");
});

test("read and write each service's registry cache under a tag for its platform, on the cache builder that a build creates when it is missing", async () => {
  const { calls, tags } = await build("cache", "ghcr.io/owner/app-qa-cache");
  expect(calls.filter((call) => call.startsWith("buildx"))).toEqual([
    "buildx inspect qa-interns-cache BUILDX_BUILDER=",
    "buildx create --name qa-interns-cache --driver docker-container BUILDX_BUILDER=",
  ]);
  expect(calls.at(-1)).toEndWith(" build web api BUILDX_BUILDER=qa-interns-cache");
  expect(tags).toContain('      cache_from: ["type=registry,ref=ghcr.io/owner/app-qa-cache:qa-web-linux-amd64"]\n');
  expect(tags).toContain('      cache_to: ["type=registry,ref=ghcr.io/owner/app-qa-cache:qa-web-linux-amd64,mode=max,ignore-error=true"]\n');
  expect(tags).toContain('      cache_from: ["type=registry,ref=ghcr.io/owner/app-qa-cache:qa-api-linux-arm64-v8"]\n');
  expect(tags).toContain('      cache_to: ["type=registry,ref=ghcr.io/owner/app-qa-cache:qa-api-linux-arm64-v8,mode=max,ignore-error=true"]\n');
});
