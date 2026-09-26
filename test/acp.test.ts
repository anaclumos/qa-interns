import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { AgentError, openSession, type Session } from "../src/acp.ts";
import { providers } from "../src/providers.ts";

const dockerAvailable = Bun.spawnSync(["docker", "info"], { stdout: "ignore", stderr: "ignore" }).exitCode === 0;

const image = "node:24-trixie-slim";
const page = "<!doctype html><h1>Ledger</h1><p>Fake defect marker</p>";
const name = `qair-c-${crypto.randomUUID().slice(0, 8)}`;
const agent = `${name}-agent`;
const web = `${name}-web`;
const root = path.join(tmpdir(), name);
const out = path.join(root, "out");
const login = path.join(root, "login");
const credentials = path.join(login, ".credentials.json");
const internDir = path.join(root, "intern");
const transcript = path.join(internDir, "transcript.jsonl");
const adapterLog = path.join(internDir, "adapter.log");

const internPrompt = [
  "You are a QA intern testing a web application for 15 minutes.",
  "Charter: sign-up and sign-in with unusual input",
  "The application runs at:",
  "- app: http://web:8080/",
  "Accounts: {\"users\":[{\"email\":\"owner@example.test\",\"password\":\"correct horse\"}]}",
  "Write each finding as one JSON file in /qa/out/findings/ and keep evidence under /qa/out.",
].join("\n");

type Line = { t: string; from: "client" | "agent"; message: Record<string, unknown> };

async function docker(...args: string[]): Promise<string> {
  const proc = Bun.spawn(["docker", ...args], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  if (code !== 0) throw new Error(`docker ${args.join(" ")} exited with ${code}: ${stderr.slice(-2000)}`);
  return stdout.trim();
}

function transcriptLines(): Line[] {
  return readFileSync(transcript, "utf8")
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line));
}

function execProcesses(container: string): string[] {
  return readdirSync("/proc")
    .filter((entry) => Number.isInteger(Number(entry)))
    .filter((pid) => {
      try {
        const args = readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0");
        return args.includes("exec") && args.includes(container);
      } catch (error) {
        if (error instanceof Error && "code" in error && (error.code === "ENOENT" || error.code === "ESRCH")) return false;
        throw error;
      }
    });
}

async function until(check: () => boolean | Promise<boolean>, what: string) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (await check()) return;
    await Bun.sleep(100);
  }
  throw new Error(`timed out waiting for ${what}`);
}

describe.skipIf(!dockerAvailable)("openSession against the fake agent", () => {
  let session: Session;

  beforeAll(async () => {
    mkdirSync(root);
    mkdirSync(out);
    mkdirSync(login);
    writeFileSync(credentials, "{}");
    mkdirSync(internDir);
    await docker("network", "create", name);
    const server = `require("node:http").createServer((request, response) => response.end(${JSON.stringify(page)})).listen(8080)`;
    await docker("run", "-d", "--name", web, "--network", name, "--network-alias", "web", image, "node", "-e", server);
    await docker(
      "run",
      "-d",
      "--name",
      agent,
      "--network",
      name,
      "--user",
      `${process.getuid?.()}:${process.getgid?.()}`,
      "-e",
      "CLAUDE_CONFIG_DIR=/qa/login",
      "-v",
      `${path.join(import.meta.dir, "fake-agent.mjs")}:/opt/qa/fake-agent.mjs:ro`,
      "-v",
      `${out}:/qa/out`,
      "-v",
      `${login}:/qa/login`,
      image,
      "sleep",
      "infinity",
    );
    const probe = `fetch("http://web:8080/").then((response) => process.exit(response.ok ? 0 : 1), () => process.exit(1))`;
    await until(
      async () => (await Bun.spawn(["docker", "exec", agent, "node", "-e", probe], { stdout: "ignore", stderr: "ignore" }).exited) === 0,
      "the page server to answer",
    );
  }, 30_000);

  afterAll(async () => {
    await session?.close();
    await docker("rm", "-f", agent, web);
    await docker("network", "rm", name);
    rmSync(root, { recursive: true, force: true });
  }, 30_000);

  test("opens a session with no MCP servers, the Claude meta, and the Claude mode", async () => {
    session = await openSession({
      container: agent,
      provider: { ...providers.claude, adapter: ["node", "/opt/qa/fake-agent.mjs"] },
      transcript,
      adapterLog,
    });
    expect(session.model).toBe("fake-model-1");
    expect(JSON.parse(readFileSync(path.join(out, "fake-agent-session.json"), "utf8"))).toEqual({
      mcpServers: [],
      _meta: { claudeCode: { options: { strictMcpConfig: true } } },
    });
    const setMode = transcriptLines().find((line) => line.from === "client" && line.message.method === "session/set_mode");
    expect(setMode?.message.params).toEqual({ sessionId: "fake-session-1", modeId: "bypassPermissions" });
  });

  test("an intern prompt makes one tool call and writes a finding with evidence", async () => {
    expect(await session.prompt(internPrompt)).toEqual({ stopReason: "end_turn", toolCalls: 1, lastMessage: "Recorded one finding." });
    const lines = transcriptLines();
    const permission = lines.find((line) => line.from === "agent" && line.message.method === "session/request_permission");
    const answer = lines.find((line) => line.from === "client" && line.message.id === permission?.message.id && "result" in line.message);
    expect(answer?.message.result).toEqual({ outcome: { outcome: "selected", optionId: "allow-once" } });
    const finding = JSON.parse(readFileSync(path.join(out, "findings", "fake-home.json"), "utf8"));
    expect(finding.title).toBe("Home page shows the fake defect");
    expect(finding.evidence).toEqual(["evidence/page.html"]);
    expect(readFileSync(path.join(out, finding.evidence[0]), "utf8")).toBe(page);
  });

  test("a continue prompt makes no tool call", async () => {
    const result = await session.prompt("You have 12 minutes left. Keep testing your charter. No finding files were rejected so far.");
    expect(result).toEqual({ stopReason: "end_turn", toolCalls: 0, lastMessage: "Nothing more to test." });
  });

  test("a usage limit rejects the prompt with an AgentError that Claude counts as a login failure", async () => {
    writeFileSync(credentials, JSON.stringify({ limit: true }));
    let error: unknown;
    try {
      await session.prompt("You have 11 minutes left. Keep testing your charter.");
    } catch (reason) {
      error = reason;
    }
    writeFileSync(credentials, "{}");
    expect(error).toBeInstanceOf(AgentError);
    expect(error).toMatchObject({ code: -32603, message: "Internal error: You've hit your limit", data: { errorKind: "rate_limit" } });
    expect(error instanceof AgentError && providers.claude.isLoginFailure(error)).toBe(true);
  });

  test("cancel during a slow prompt resolves it as cancelled", async () => {
    const turn = session.prompt("SLOW: keep working until you are stopped.");
    await until(
      () => transcriptLines().some((line) => JSON.stringify(line.message).includes("Slow turn started.")),
      "the slow turn to start",
    );
    await session.cancel();
    expect(await turn).toEqual({ stopReason: "cancelled", toolCalls: 0, lastMessage: "Slow turn started." });
  });

  test("close ends the docker exec process and is idempotent", async () => {
    expect(execProcesses(agent)).toHaveLength(1);
    await Promise.all([session.close(), session.close()]);
    expect(execProcesses(agent)).toHaveLength(0);
    await session.close();
  });

  test("the transcript holds one timestamped JSON object per line from both sides", () => {
    const lines = transcriptLines();
    for (const line of lines) {
      expect(new Date(line.t).toISOString()).toBe(line.t);
      expect(["client", "agent"]).toContain(line.from);
      expect(line.message.jsonrpc).toBe("2.0");
    }
    const prompts = lines.filter((line) => line.from === "client" && line.message.method === "session/prompt");
    expect(prompts).toHaveLength(4);
    expect(JSON.stringify(prompts[0]?.message.params)).toContain("Charter: sign-up and sign-in with unusual input");
    const results = lines.filter((line) => line.from === "agent" && prompts.some((prompt) => prompt.message.id === line.message.id));
    expect(results.map((line) => line.message.result ?? line.message.error)).toEqual([
      { stopReason: "end_turn" },
      { stopReason: "end_turn" },
      { code: -32603, message: "Internal error: You've hit your limit", data: { errorKind: "rate_limit" } },
      { stopReason: "cancelled" },
    ]);
  });
});
