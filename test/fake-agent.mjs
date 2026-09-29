import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { closeSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import { createInterface } from "node:readline";

const sessionId = "fake-session-1";
const pending = new Map();
let nextId = 1;
let cancelTurn = null;

const send = (message) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);

const request = (method, params) =>
  new Promise((resolve) => {
    const id = nextId++;
    pending.set(id, resolve);
    send({ id, method, params });
  });

const update = (value) => send({ method: "session/update", params: { sessionId, update: value } });

const say = (text) => update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text } });

const firstUrl = (text) => {
  const start = text.indexOf("http://");
  if (start === -1) throw new Error("the prompt names no http:// URL");
  let end = start;
  while (end < text.length && !" \t\r\n\"'<>()[]{},".includes(text[end])) end += 1;
  let url = text.slice(start, end);
  while (url.endsWith(".")) url = url.slice(0, -1);
  return url;
};

const closingBrace = (text, start) => {
  let depth = 0;
  let inString = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (char === "\\") index += 1;
      else if (char === '"') inString = false;
    } else if (char === '"') inString = true;
    else if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
};

const listedFindings = (text) => {
  const findings = [];
  let index = 0;
  while (index < text.length) {
    const end = text[index] === "{" ? closingBrace(text, index) : -1;
    if (end !== -1) {
      let value = null;
      try {
        value = JSON.parse(text.slice(index, end + 1));
      } catch {
        value = null;
      }
      if (value !== null && typeof value.id === "string" && typeof value.title === "string") {
        findings.push(value);
        index = end + 1;
        continue;
      }
    }
    index += 1;
  }
  return findings;
};

const seededAccount = (text) => {
  const fence = "```json\n";
  const start = text.indexOf(fence);
  if (start === -1) return undefined;
  const block = text.slice(start + fence.length);
  return JSON.parse(block.slice(0, block.indexOf("\n```"))).accounts?.[0];
};

const writeJson = (file, value) => writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);

const login = () => JSON.parse(readFileSync(process.env.FAKE_CREDENTIAL, "utf8"));

const chunk = randomBytes(1024 ** 2);

const hold = (file, mib) => {
  const fd = openSync(file, "w");
  unlinkSync(file);
  for (let index = 0; index < mib; index += 1) writeSync(fd, chunk);
};

const fill = (file) => {
  const fd = openSync(file, "w");
  try {
    for (;;) writeSync(fd, chunk);
  } catch (error) {
    if (error.code !== "ENOSPC") throw error;
  } finally {
    closeSync(fd);
  }
};

const endTurn = { result: { stopReason: "end_turn" } };

const charterTurn = async (text) => {
  const permission = await request("session/request_permission", {
    sessionId,
    toolCall: { toolCallId: "call-1", title: "Fetch the home page", kind: "fetch", status: "pending" },
    options: [
      { optionId: "allow-always", name: "Always allow", kind: "allow_always" },
      { optionId: "allow-once", name: "Allow", kind: "allow_once" },
      { optionId: "reject-once", name: "Reject", kind: "reject_once" },
    ],
  });
  if (permission.result?.outcome?.outcome !== "selected") {
    say("Permission was not granted.");
    return endTurn;
  }
  update({ sessionUpdate: "tool_call", toolCallId: "call-1", title: "Fetch the home page", kind: "fetch", status: "in_progress" });
  const url = firstUrl(text);
  const response = await fetch(url);
  if (!response.ok) throw new Error(`GET ${url} answered ${response.status}`);
  mkdirSync("/qa/out/evidence", { recursive: true });
  writeFileSync("/qa/out/evidence/page.html", await response.text());
  writeFileSync("/qa/out/evidence/prompt.txt", text);
  const account = seededAccount(text);
  if (text.includes("agent-browser")) {
    const browser = (...args) => execFileSync("agent-browser", args, { encoding: "utf8", env: { ...process.env, AGENT_BROWSER_SESSION: "fake" } });
    browser("open", url);
    writeFileSync("/qa/out/evidence/browser.json", browser("eval", "({ isSecureContext, randomUUID: typeof crypto.randomUUID, subtle: typeof crypto.subtle, clipboard: typeof navigator.clipboard })"));
    browser("close");
  }
  mkdirSync("/qa/out/findings", { recursive: true });
  writeJson("/qa/out/findings/fake-home.json", {
    title: "Home page shows the fake defect",
    kind: "error",
    conditions: {
      account: "no account, signed out",
      data: "freshly seeded data",
      viewport: "1280x800",
      browser: "fresh profile",
      network: "normal",
    },
    steps: [`Open ${url}`, ...(account === undefined ? [] : [`Sign in as ${account.email} with the password ${account.password}.`])],
    observed: "The home page body contains the fake defect marker.",
    evidence: ["evidence/page.html"],
  });
  update({ sessionUpdate: "tool_call_update", toolCallId: "call-1", status: "completed" });
  if (account !== undefined) {
    const cut = Math.floor(account.password.length / 2);
    say(`Signed in as ${account.email} with ${account.password.slice(0, cut)}`);
    say(`${account.password.slice(cut)}.`);
  }
  say("Recorded one finding.");
  if (login().flood === true) {
    hold("/qa/out/evidence/held.bin", 600);
    fill("/qa/out/evidence/big.bin");
    return slowTurn();
  }
  return endTurn;
};

const groupsTurn = (text) => {
  const byTitle = new Map();
  for (const finding of listedFindings(text)) {
    byTitle.set(finding.title, [...(byTitle.get(finding.title) ?? []), finding.id]);
  }
  writeJson("/qa/out/groups.json", { groups: [...byTitle.values()] });
  say("Wrote the groups.");
  return endTurn;
};

const confirmationTurn = () => {
  if (login().confirms === false) {
    say("The confirmation did not finish.");
    return endTurn;
  }
  mkdirSync("/qa/out/evidence", { recursive: true });
  writeFileSync("/qa/out/evidence/reproduction.txt", "fake reproduction\n");
  writeJson("/qa/out/confirmation.json", { reproduced: true, observed: "fake reproduction", evidence: ["evidence/reproduction.txt"] });
  say("Wrote the confirmation.");
  return endTurn;
};

const slowTurn = async () => {
  const cancelled = new Promise((resolve) => {
    cancelTurn = resolve;
  });
  say("Slow turn started.");
  await cancelled;
  return { result: { stopReason: "cancelled" } };
};

const limited = { error: { code: -32603, message: "Internal error: You've hit your limit", data: { errorKind: "rate_limit" } } };

const prompt = async (params) => {
  const text = params.prompt
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");
  const { limit } = login();
  if (limit === true) return limited;
  if (text.includes("/qa/out/groups.json")) return groupsTurn(text);
  if (text.includes("/qa/out/confirmation.json")) {
    const result = confirmationTurn();
    return limit === "confirmation" ? limited : result;
  }
  if (text.includes("Charter:")) {
    const result = await charterTurn(text);
    return limit === "charter" ? limited : result;
  }
  if (text.includes("SLOW")) return slowTurn();
  say("Nothing more to test.");
  return endTurn;
};

const handlers = {
  initialize: () => ({
    result: { protocolVersion: 1, agentCapabilities: { loadSession: false }, agentInfo: { name: "fake-agent", version: "1.0.0" }, authMethods: [] },
  }),
  "session/new": (params) => {
    writeJson("/qa/out/fake-agent-session.json", { mcpServers: params.mcpServers, _meta: params._meta ?? null });
    const model = login().model ?? "fake-model-1";
    return {
      result: {
        sessionId,
        configOptions: [
          {
            id: "model",
            name: "Model",
            category: "model",
            type: "select",
            currentValue: model,
            options: [{ value: model, name: model }],
          },
        ],
      },
    };
  },
  "session/set_mode": () => ({ result: {} }),
  "session/prompt": prompt,
};

createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === undefined) {
    pending.get(message.id)(message);
    pending.delete(message.id);
    return;
  }
  if (message.method === "session/cancel") {
    cancelTurn?.();
    cancelTurn = null;
    return;
  }
  const handler = handlers[message.method];
  if (handler === undefined) {
    if (message.id !== undefined) send({ id: message.id, error: { code: -32601, message: `Method not found: ${message.method}` } });
    return;
  }
  Promise.resolve()
    .then(() => handler(message.params))
    .then(
      (outcome) => send({ id: message.id, ...outcome }),
      (error) => send({ id: message.id, error: { code: -32603, message: `Internal error: ${error.message}` } }),
    );
});
