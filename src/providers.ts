import type { RequestError } from "@agentclientprotocol/sdk";
import { readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { minLength } from "./secrets.ts";
import type { GeneratedFile, Mount, Provider } from "./types.ts";

export type Access = { env: Record<string, string>; egress: string[]; key: string | null };

export type ProviderSpec = {
  adapter: string[];
  access(store: string): Access;
  mounts(store: string): Mount[];
  files: GeneratedFile[];
  tmpfs: string[];
  clientMeta: Record<string, unknown> | null;
  sessionMeta: Record<string, unknown> | null;
  modeId: string | null;
  modelConfig(model: string): ConfigValue[];
  isLoginFailure(error: RequestError): boolean;
};

type ConfigValue = { configId: string; value: string };

const authRequired = -32000;
const rateLimited = -32003;
const internalError = -32603;
const claudeLoginKinds = [
  "rate_limit",
  "billing_error",
  "authentication_failed",
  "oauth_org_not_allowed",
  "account_on_hold",
  "verification_required",
];
const codexLoginErrors = ["usageLimitExceeded", "unauthorized"];
const claudeLoginData = z.object({ errorKind: z.enum(claudeLoginKinds) });
const codexLoginData = z.object({ codexErrorInfo: z.enum(codexLoginErrors) });
const grokLoginData = z.object({ http_status: z.literal([401, 402]) });

const codexConfig = `[features]
apps = false
plugins = false

[analytics]
enabled = false
`;

const opencodeHosts = { "opencode-go": ["opencode.ai"], openrouter: ["openrouter.ai"] };
const opencodeProviders = { "opencode-go": {}, openrouter: { openrouter: { options: { extraBody: { provider: { zdr: true } } } } } };
const apiKey = z.strictObject({ type: z.literal("api"), key: z.string().min(minLength) });
const opencodeAuth = z.union([
  z.strictObject({ "opencode-go": apiKey }).transform((auth) => ({ provider: "opencode-go" as const, key: auth["opencode-go"].key })),
  z.strictObject({ openrouter: apiKey }).transform((auth) => ({ provider: "openrouter" as const, key: auth.openrouter.key })),
]);

export const opencodeAuthRule = `must hold one opencode-go or openrouter API key of at least ${minLength} characters and nothing else`;

export function opencodeLogin(file: string): z.infer<typeof opencodeAuth> | null {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    if (error instanceof SyntaxError) return null;
    throw error;
  }
  return opencodeAuth.safeParse(value).data ?? null;
}

const opencodeEnv = {
  XDG_DATA_HOME: "/home/qa/.local/share",
  OPENCODE_DISABLE_MODELS_FETCH: "true",
  OPENCODE_DISABLE_PROJECT_CONFIG: "true",
  OPENCODE_PERMISSION: JSON.stringify({
    "*": "deny",
    ...Object.fromEntries(
      ["bash", "read", "glob", "grep", "edit", "task", "webfetch", "todowrite", "invalid", "external_directory", "doom_loop"].map((name) => [name, "allow"]),
    ),
  }),
};

function storePath(store: string): string {
  if (!path.isAbsolute(store)) throw new Error(`login store must be an absolute path, got "${store}"`);
  return store;
}

function fixed(env: Record<string, string>, egress: string[]): () => Access {
  return () => ({ env, egress, key: null });
}

function opencodeAccess(store: string): Access {
  const file = path.join(storePath(store), "auth.json");
  const login = opencodeLogin(file);
  if (login === null) throw new Error(`${file} ${opencodeAuthRule}`);
  const config = { enabled_providers: [login.provider], agent: { title: { disable: true } }, provider: opencodeProviders[login.provider] };
  return { env: { ...opencodeEnv, OPENCODE_CONFIG_CONTENT: JSON.stringify(config) }, egress: opencodeHosts[login.provider], key: login.key };
}

function plainModel(model: string): ConfigValue[] {
  return [{ configId: "model", value: model }];
}

function cursorModel(model: string): ConfigValue[] {
  const open = model.indexOf("[");
  if (open === -1) return plainModel(model);
  if (!model.endsWith("]")) throw new Error(`Cursor model ${model} does not end with ]`);
  const parameters = model
    .slice(open + 1, -1)
    .split(",")
    .filter((entry) => entry !== "")
    .map((entry) => {
      const [configId, value, ...rest] = entry.split("=");
      if (configId === undefined || configId === "" || value === undefined || rest.length > 0) throw new Error(`Cursor model ${model} has a parameter that is not name=value: ${entry}`);
      return { configId, value };
    });
  return [...plainModel(model.slice(0, open)), ...parameters];
}

export const providers: Record<Provider, ProviderSpec> = {
  claude: {
    adapter: ["claude-agent-acp"],
    access: fixed(
      {
        CLAUDE_CONFIG_DIR: "/home/qa/.claude",
        CLAUDE_SECURESTORAGE_CONFIG_DIR: "/home/qa/.claude-login",
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
        ENABLE_CLAUDEAI_MCP_SERVERS: "false",
        DISABLE_AUTOUPDATER: "1",
      },
      ["api.anthropic.com", "platform.claude.com"],
    ),
    mounts: (store) => [{ source: storePath(store), target: "/home/qa/.claude-login", readOnly: false }],
    files: [],
    tmpfs: ["/home/qa/.claude"],
    clientMeta: null,
    sessionMeta: { claudeCode: { options: { strictMcpConfig: true } } },
    modeId: "bypassPermissions",
    modelConfig: plainModel,
    isLoginFailure: (error) => error.code === authRequired || (error.code === internalError && claudeLoginData.safeParse(error.data).success),
  },
  codex: {
    adapter: ["codex-acp"],
    access: fixed({ CODEX_HOME: "/home/qa/.codex", INITIAL_AGENT_MODE: "agent-full-access", NO_BROWSER: "1" }, ["chatgpt.com", "auth.openai.com", "api.openai.com"]),
    mounts: (store) => [{ source: path.join(storePath(store), "auth.json"), target: "/home/qa/.codex/auth.json", readOnly: false }],
    files: [{ target: "/home/qa/.codex/config.toml", content: codexConfig }],
    tmpfs: ["/home/qa/.codex"],
    clientMeta: null,
    sessionMeta: null,
    modeId: null,
    modelConfig: plainModel,
    isLoginFailure: (error) => error.code === authRequired || (error.code === internalError && codexLoginData.safeParse(error.data).success),
  },
  cursor: {
    adapter: ["cursor-agent", "--force", "acp"],
    access: fixed({ XDG_CONFIG_HOME: "/home/qa/.config", CURSOR_CONFIG_DIR: "/home/qa/.cursor" }, ["*.cursor.sh"]),
    mounts: (store) => [{ source: storePath(store), target: "/home/qa/.config/cursor", readOnly: false }],
    files: [],
    tmpfs: ["/home/qa/.config"],
    clientMeta: { parameterizedModelPicker: true },
    sessionMeta: null,
    modeId: null,
    modelConfig: cursorModel,
    isLoginFailure: (error) => error.code === authRequired,
  },
  grok: {
    adapter: ["grok", "agent", "--always-approve", "stdio"],
    access: fixed({ GROK_AUTH_PATH: "/home/qa/.grok-login/auth.json" }, ["cli-chat-proxy.grok.com", "auth.x.ai"]),
    mounts: (store) => [{ source: storePath(store), target: "/home/qa/.grok-login", readOnly: false }],
    files: [],
    tmpfs: [],
    clientMeta: null,
    sessionMeta: null,
    modeId: null,
    modelConfig: plainModel,
    isLoginFailure: (error) =>
      error.code === authRequired || error.code === rateLimited || (error.code === internalError && grokLoginData.safeParse(error.data).success),
  },
  opencode: {
    adapter: ["opencode", "acp"],
    access: opencodeAccess,
    mounts: (store) => [{ source: path.join(storePath(store), "auth.json"), target: "/home/qa/.local/share/opencode/auth.json", readOnly: true }],
    files: [],
    tmpfs: ["/home/qa/.local", "/home/qa/.local/share", "/home/qa/.local/share/opencode"],
    clientMeta: null,
    sessionMeta: null,
    modeId: null,
    modelConfig: plainModel,
    isLoginFailure: () => false,
  },
};
