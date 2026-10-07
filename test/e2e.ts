import { afterAll, beforeAll } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { cp, mkdir, readdir } from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import { basename, join } from "node:path";
import { removeDir, writeChromePolicy } from "../src/environment.ts";
import type { AskOptions } from "../src/run.ts";
import { ensureRunnerImage } from "../src/runner.ts";
import { capture, execute } from "../src/target.ts";
import type { RunState } from "../src/types.ts";
import { suiteLabel } from "./suite-lock.ts";

export const dockerAvailable = Bun.spawnSync(["docker", "info"], { stdout: "ignore", stderr: "ignore" }).exitCode === 0;
export const timeout = 20 * 60_000;
export const cliScript = join(import.meta.dir, "..", "src", "cli.ts");
export const title = "Home page shows the fake defect";
export const knownGap = "The environment has no video model.";
export const runLocks = join(process.env.XDG_RUNTIME_DIR ?? "", "qa-interns", "runs");
export const intendedBehavior = "The invoices table scrolls sideways at narrow viewports instead of clipping its columns.";

type FakeAgent = { limit?: true | "charter"; confirms?: false; late?: true; deaf?: true; swap?: true; flood?: true; idle?: true; hang?: true | string; stray?: true; second?: true; printKey?: true; nonce?: string };

export function endToEnd() {
  const id = crypto.randomUUID().slice(0, 8);
  const root = join(tmpdir(), `qair-f-e2e-${id}`);
  const fakeRepo = `qair-f-e2e-runner-${userInfo().uid}`;
  const fakeImage = `${fakeRepo}:${process.pid}-${id}`;
  const target = join(root, "repo", "eval", "ledger");
  let previousStateHome: string | undefined;
  let built = false;

  beforeAll(async () => {
    previousStateHome = process.env.XDG_STATE_HOME;
    await mkdir(root);
    await cp(join(import.meta.dir, "..", "eval", "ledger"), target, { recursive: true, filter: (source) => basename(source) !== "node_modules" });
    const feature = join(target, ".devcontainer", "probe-feature");
    await mkdir(feature);
    await Bun.write(join(feature, "devcontainer-feature.json"), JSON.stringify({ id: "probe-feature", version: "1.0.0", name: "Probe feature" }));
    await Bun.write(join(feature, "install.sh"), "#!/bin/sh\nset -e\n");
    const devcontainerFile = join(target, ".devcontainer", "devcontainer.json");
    const ledger = await Bun.file(devcontainerFile).json();
    const customizations = { "qa-interns": { ...ledger.customizations["qa-interns"], knownGaps: [knownGap], intendedBehaviors: [intendedBehavior] } };
    await Bun.write(devcontainerFile, JSON.stringify({ ...ledger, customizations, features: { "./probe-feature": {} } }));
    const git = ["git", "-C", join(root, "repo"), "-c", "user.name=QA Interns", "-c", "user.email=qa@example.test", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null"];
    await execute([...git, "init", "-q"]);
    await execute([...git, "add", "-A"]);
    await execute([...git, "commit", "-q", "-m", "Ledger"]);

    const base = await ensureRunnerImage();
    const context = join(root, "image");
    await mkdir(context);
    await cp(join(import.meta.dir, "fake-agent.mjs"), join(context, "fake-agent.mjs"));
    await Bun.write(
      join(context, "Dockerfile"),
      `FROM ${base}
USER root
COPY fake-agent.mjs /opt/qa-fake/fake-agent.mjs
RUN rm /usr/local/bin/pi-acp \\
 && printf '#!/bin/sh\\nexec env FAKE_CREDENTIAL="$PI_CODING_AGENT_DIR/auth.json" node /opt/qa-fake/fake-agent.mjs "$@"\\n' > /usr/local/bin/pi-acp \\
 && chmod 755 /usr/local/bin/pi-acp
USER qa
`,
    );
    await execute(["docker", "build", "-q", "-t", fakeImage, context]);
    built = true;
    process.env.XDG_STATE_HOME = join(root, "state");
  }, timeout);

  afterAll(async () => {
    if (previousStateHome === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = previousStateHome;
    try {
      await removeDir(root, fakeImage, `qair-f-e2e-${id}`);
    } finally {
      if (built) await execute(["docker", "image", "rm", "-f", fakeImage]);
    }
    const earlier = (await execute(["docker", "image", "ls", "--filter", `reference=${fakeRepo}`, "--format", "{{.Repository}}:{{.Tag}}"])).split("\n").filter((image) => image !== "");
    const unused = [];
    for (const image of earlier) {
      const owner = Number(image.slice(image.indexOf(":") + 1).split("-")[0]);
      if (Number.isSafeInteger(owner) && existsSync(join("/proc", String(owner)))) continue;
      if ((await execute(["docker", "ps", "-aq", "--filter", `ancestor=${image}`])) === "") unused.push(image);
    }
    if (unused.length > 0) await execute(["docker", "image", "rm", "-f", ...unused]);
  }, timeout);

  async function logins(name: string, fake: FakeAgent = {}, concurrency = 1): Promise<string> {
    const store = join(root, "stores", name);
    await mkdir(store, { recursive: true });
    await Bun.write(join(store, "auth.json"), JSON.stringify({ openrouter: { type: "api_key", key: `fake-agent:${JSON.stringify(fake)}` } }));
    const file = join(root, `${name}-logins.json`);
    await Bun.write(file, JSON.stringify({ id: "openrouter-1", store, concurrency }));
    return file;
  }

  async function askOptions(runId: string, name: string): Promise<AskOptions> {
    const runDir = join(root, "asks", runId);
    await mkdir(runDir, { recursive: true });
    await writeChromePolicy(runDir, {});
    return {
      runDir,
      runId,
      name,
      loginsFile: await logins(`ask-${runId}`),
      runnerImage: fakeImage,
      admit: () => () => {},
      prompt: "Write /qa/out/groups.json.",
      file: "groups.json",
      parse: (raw) => JSON.parse(raw),
    };
  }

  function blockTeardown(runDir: string, internId: string): () => Promise<void> {
    const held = `qair-f-e2e-held-${basename(runDir)}-${internId}`;
    Bun.spawnSync(["docker", "network", "create", "--internal", "--label", `com.docker.compose.project=qa-${basename(runDir)}-${internId}`, "--label", suiteLabel, held], { stdout: "ignore" });
    Bun.spawnSync(["docker", "run", "-d", "--rm", "--label", suiteLabel, "--name", held, "--network", held, fakeImage], { stdout: "ignore" });
    return async () => {
      await capture(["docker", "rm", "-f", held]);
      await capture(["docker", "network", "rm", held]);
    };
  }

  return { id, root, fakeImage, target, logins, askOptions, blockTeardown };
}

export async function leftovers(runId: string): Promise<string[]> {
  const prefixes = [`qa-${runId}-`, `vsc-qa-${runId}-`];
  const listings = await Promise.all([
    execute(["docker", "ps", "-a", "--format", "{{.Names}}"]),
    execute(["docker", "network", "ls", "--format", "{{.Name}}"]),
    execute(["docker", "volume", "ls", "--format", "{{.Name}}"]),
    execute(["docker", "images", "--format", "{{.Repository}}:{{.Tag}}"]),
  ]);
  return listings
    .join("\n")
    .split("\n")
    .filter((name) => prefixes.some((prefix) => name.startsWith(prefix)));
}

export async function workspaces(runDir: string, state: RunState): Promise<string[]> {
  const names = await Promise.all(state.interns.map(async (intern) => (await readdir(join(runDir, "envs", intern.id))).filter((entry) => entry === `qa-${state.runId}-${intern.id}` || entry === "tmp")));
  return names.flat();
}

export async function disks(runDir: string, state: RunState): Promise<string[]> {
  const images = await Promise.all(state.interns.map(async (intern) => (await readdir(join(runDir, "interns", intern.id))).filter((entry) => entry.endsWith(".img") || entry.endsWith(".img.new"))));
  const mounts = readFileSync("/proc/self/mountinfo", "utf8").split("\n").filter((line) => line.includes(runDir));
  return [...images.flat(), ...mounts];
}

export function intern(state: RunState, internId: string) {
  const found = state.interns.find((entry) => entry.id === internId);
  if (found === undefined) throw new Error(`state has no intern ${internId}`);
  return found;
}

export async function firstPrompt(runDir: string, internId: string): Promise<string> {
  const lines = (await Bun.file(join(runDir, "interns", internId, "transcript.jsonl")).text()).split("\n").filter((line) => line !== "");
  const prompt = lines.map((line) => JSON.parse(line)).find((line) => line.from === "client" && line.message.method === "session/prompt");
  if (prompt === undefined) throw new Error(`transcript of ${internId} has no session/prompt`);
  return prompt.message.params.prompt.map((block: { text: string }) => block.text).join("\n");
}

export function internalSubnet(runDir: string, internId: string): string {
  const network = readFileSync(join(runDir, "envs", internId, "compose.qa.yml"), "utf8")
    .split("\n")
    .find((entry) => entry.startsWith("  qa_internal: !override "));
  if (network === undefined) throw new Error(`compose.qa.yml of ${internId} has no qa_internal network`);
  return JSON.parse(network.slice("  qa_internal: !override ".length)).ipam.config[0].subnet;
}
