import { RequestError } from "@agentclientprotocol/sdk";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { openSession, type Session } from "../src/acp.ts";
import { providers } from "../src/providers.ts";
import { forgetSecrets, keepSeedSecrets } from "../src/secrets.ts";

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

function fakeSession(label: string, model: string | null = null): Promise<Session> {
  return openSession({
    container: agent,
    provider: { ...providers.claude, adapter: ["node", "/opt/qa/fake-agent.mjs"] },
    model,
    transcript: path.join(internDir, `${label}-transcript.jsonl`),
    adapterLog: path.join(internDir, `${label}-adapter.log`),
  });
}

const findAdapter = [
  "const { openSync, readdirSync, readFileSync, writeSync } = require('node:fs');",
  "const pid = readdirSync('/proc')",
  "  .filter((entry) => Number.isInteger(Number(entry)))",
  "  .find((entry) => readFileSync(`/proc/${entry}/cmdline`, 'utf8').split('\\0')[1] === '/opt/qa/fake-agent.mjs');",
];

function printAsAdapter(pieces: string, stream: 1 | 2 = 1): Promise<string> {
  const script = [...findAdapter, `const fd = openSync(\`/proc/\${pid}/fd/${stream}\`, 'w');`, `for (const piece of ${pieces}) writeSync(fd, piece);`];
  return docker("exec", agent, "node", "-e", script.join("\n"));
}

function signalAdapter(signal: "SIGSTOP" | "SIGCONT"): Promise<string> {
  return docker("exec", agent, "node", "-e", [...findAdapter, `process.kill(Number(pid), "${signal}");`].join("\n"));
}

function updateLines(...updates: object[]): string {
  return updates.map((update) => `${JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "fake-session-1", update } })}\n`).join("");
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
      "FAKE_CREDENTIAL=/qa/login/.credentials.json",
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
      model: null,
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

  test("a continue prompt makes no tool call, and the session keeps the count of every turn", async () => {
    const result = await session.prompt("You have 12 minutes left. Keep testing your charter. No finding files were rejected so far.");
    expect(result).toEqual({ stopReason: "end_turn", toolCalls: 0, lastMessage: "Nothing more to test." });
    expect(session.toolCalls()).toBe(1);
  });

  test("a usage limit rejects the prompt with a RequestError that Claude counts as a login failure", async () => {
    writeFileSync(credentials, JSON.stringify({ limit: true }));
    let error: unknown;
    try {
      await session.prompt("You have 11 minutes left. Keep testing your charter.");
    } catch (reason) {
      error = reason;
    }
    writeFileSync(credentials, "{}");
    expect(error).toBeInstanceOf(RequestError);
    expect(error).toMatchObject({ code: -32603, message: "Internal error: You've hit your limit", data: { errorKind: "rate_limit" } });
    expect(error instanceof RequestError && providers.claude.isLoginFailure(error)).toBe(true);
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

  test("another process in the runner cannot grow the adapter log or the transcript past 64 MiB", async () => {
    const limit = 64 * 1024 ** 2;
    const floodLog = path.join(internDir, "flood-adapter.log");
    const floodTranscript = path.join(internDir, "flood-transcript.jsonl");
    const flooded = await fakeSession("flood");
    try {
      await printAsAdapter("['x'.repeat(80 * 2 ** 20)]", 2);
      await printAsAdapter("Array.from({ length: 80 }, () => JSON.stringify({ jsonrpc: '2.0', method: 'flood', params: { pad: 'x'.repeat(2 ** 20) } }) + '\\n')");
      await until(() => statSync(floodLog).size > limit - 2 ** 20 && statSync(floodTranscript).size > limit - 2 ** 21, "the flood to fill both files");
      const result = await flooded.prompt("You have 10 minutes left. Keep testing your charter.");
      expect(result).toEqual({ stopReason: "end_turn", toolCalls: 0, lastMessage: "Nothing more to test." });
    } finally {
      await flooded.close();
    }
    expect(statSync(floodLog).size).toBeLessThanOrEqual(limit);
    expect(statSync(floodTranscript).size).toBeLessThanOrEqual(limit);
    const lines = readFileSync(floodTranscript, "utf8").split("\n");
    expect(lines.pop()).toBe("");
    for (const line of lines) expect(JSON.parse(line).message.jsonrpc).toBe("2.0");
  }, 60_000);

  test("a failed adapter log write fails the session's pending prompt", async () => {
    const lockedLog = path.join(internDir, "locked-adapter.log");
    const locked = await fakeSession("locked");
    try {
      const turn = locked.prompt("SLOW: keep working until you are stopped.").catch((error: unknown) => error);
      rmSync(lockedLog);
      mkdirSync(lockedLog);
      await printAsAdapter("['adapter error output\\n']", 2);
      expect(await turn).toBeInstanceOf(Error);
    } finally {
      await locked.close();
    }
  });

  test("a login model is set with session/set_config_option and reported from the agent's answer", async () => {
    const chosen = await fakeSession("model", "fake-model-2");
    try {
      expect(chosen.model).toBe("fake-model-2");
      const set = readFileSync(path.join(internDir, "model-transcript.jsonl"), "utf8")
        .split("\n")
        .filter((line) => line !== "")
        .map((line): Line => JSON.parse(line))
        .find((line) => line.from === "client" && line.message.method === "session/set_config_option");
      expect(set?.message.params).toEqual({ sessionId: "fake-session-1", configId: "model", value: "fake-model-2" });
    } finally {
      await chosen.close();
    }
  });

  test("a login model the agent does not offer fails the session with the agent's error", async () => {
    let error: unknown;
    try {
      await fakeSession("unknown-model", "no-such-model");
    } catch (reason) {
      error = reason;
    }
    expect(error).toBeInstanceOf(RequestError);
    expect(error).toMatchObject({ code: -32602, data: { message: "Invalid model value: no-such-model" } });
  });

  test("updates the agent prints between turns do not reach the next turn", async () => {
    const between = await fakeSession("between");
    try {
      const idle = { stopReason: "end_turn", toolCalls: 0, lastMessage: "Nothing more to test." };
      expect(await between.prompt("Keep testing your charter.")).toEqual(idle);
      const stale = updateLines(
        { sessionUpdate: "tool_call", toolCallId: "call-9", title: "Fetch the home page", kind: "fetch", status: "in_progress" },
        { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Printed between turns." } },
      );
      await printAsAdapter(JSON.stringify([stale]));
      await until(
        () => readFileSync(path.join(internDir, "between-transcript.jsonl"), "utf8").includes("Printed between turns."),
        "the updates to reach the transcript",
      );
      expect(await between.prompt("Keep testing your charter.")).toEqual(idle);
    } finally {
      await between.close();
    }
  });

  test("the transcript replaces a value that the agent's chunks split around another update, and keeps the order of the records", async () => {
    expect(keepSeedSecrets({ key: "sk_chunk_4f9a1c2e7b" }, ["key"])).toBeNull();
    const split = await fakeSession("split");
    const file = path.join(internDir, "split-transcript.jsonl");
    try {
      expect(await split.prompt("Keep testing your charter.")).toEqual({ stopReason: "end_turn", toolCalls: 0, lastMessage: "Nothing more to test." });
      const chunk = (text: string) => ({ sessionUpdate: "agent_message_chunk", content: { type: "text", text } });
      const lines = updateLines(
        chunk("Key sk_chu"),
        { sessionUpdate: "tool_call_update", toolCallId: "call-1", status: "completed" },
        chunk("nk_4f9a1c2e7b in use."),
        chunk(" The rest of the message follows here."),
      );
      await printAsAdapter(JSON.stringify([lines]));
      await until(() => readFileSync(file, "utf8").includes(" in use."), "the chunks before the last one to reach the transcript");
    } finally {
      await split.close();
      forgetSecrets();
    }
    const text = readFileSync(file, "utf8");
    expect(text).not.toContain("sk_chu");
    expect(text).not.toContain("nk_4f9a");
    const updates = text
      .split("\n")
      .filter((entry) => entry.includes('"method":"session/update"'))
      .map((entry) => JSON.parse(entry).message.params.update);
    expect(updates.map((update) => update.content?.text ?? update.status)).toEqual([
      "Nothing more to test.",
      "Key [redacted]",
      "completed",
      " in use.",
      " The rest of the message follows here.",
    ]);
  });

  test("a turn keeps the first 300 characters of the agent's text, printed one byte at a time", async () => {
    const long = await fakeSession("long");
    try {
      const turn = long.prompt("SLOW: keep working until you are stopped.");
      await until(() => readFileSync(path.join(internDir, "long-transcript.jsonl"), "utf8").includes("Slow turn started."), "the slow turn to start");
      const text = "The invoice total differs from the sum of its line items. ".repeat(20);
      await printAsAdapter(`${JSON.stringify(updateLines({ sessionUpdate: "agent_message_chunk", content: { type: "text", text } }))}.split("")`);
      await long.cancel();
      expect(await turn).toEqual({ stopReason: "cancelled", toolCalls: 0, lastMessage: `Slow turn started.${text}`.slice(0, 300) });
    } finally {
      await long.close();
    }
  });

  test("an agent line of more than 64 MiB with no newline fails the session", async () => {
    const overlong = await fakeSession("overlong");
    try {
      const turn = overlong.prompt("SLOW: keep working until you are stopped.");
      await until(
        () => readFileSync(path.join(internDir, "overlong-transcript.jsonl"), "utf8").includes("Slow turn started."),
        "the slow turn to start",
      );
      const flood = printAsAdapter("['x'.repeat(64 * 2 ** 20 + 1)]");
      await expect(turn).rejects.toThrow(`docker exec -i -w /qa/out ${agent} node /opt/qa/fake-agent.mjs printed more than 64 MiB without a newline`);
      await flood;
    } finally {
      await overlong.close();
    }
    expect(execProcesses(agent)).toHaveLength(0);
  }, 60_000);

  test("requests that make qa-interns send a stopped agent more than 64 MiB fail the session", async () => {
    const stalled = await fakeSession("oversent");
    try {
      const turn = stalled.prompt("SLOW: keep working until you are stopped.");
      await until(
        () => readFileSync(path.join(internDir, "oversent-transcript.jsonl"), "utf8").includes("Slow turn started."),
        "the slow turn to start",
      );
      await signalAdapter("SIGSTOP");
      const flood = printAsAdapter("Array.from({ length: 32 }, (_, id) => JSON.stringify({ jsonrpc: '2.0', id, method: 'x'.repeat(2 ** 20) }) + '\\n')");
      await expect(turn).rejects.toThrow(`qa-interns sent more than 64 MiB to docker exec -i -w /qa/out ${agent} node /opt/qa/fake-agent.mjs`);
      await flood;
    } finally {
      await signalAdapter("SIGCONT");
      await stalled.close();
    }
    expect(execProcesses(agent)).toHaveLength(0);
  }, 60_000);
});
