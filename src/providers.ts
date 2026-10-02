import type { RequestError } from "@agentclientprotocol/sdk";
import path from "node:path";
import { z } from "zod";
import type { GeneratedFile, Mount, Provider } from "./types.ts";

export type ProviderSpec = {
  adapter: string[];
  env: Record<string, string>;
  mounts(store: string): Mount[];
  files: GeneratedFile[];
  tmpfs: string[];
  egress: string[];
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

function storePath(store: string): string {
  if (!path.isAbsolute(store)) throw new Error(`login store must be an absolute path, got "${store}"`);
  return store;
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
    env: {
      CLAUDE_CONFIG_DIR: "/home/qa/.claude",
      CLAUDE_SECURESTORAGE_CONFIG_DIR: "/home/qa/.claude-login",
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      ENABLE_CLAUDEAI_MCP_SERVERS: "false",
      DISABLE_AUTOUPDATER: "1",
    },
    mounts: (store) => [{ source: storePath(store), target: "/home/qa/.claude-login", readOnly: false }],
    files: [],
    tmpfs: ["/home/qa/.claude"],
    egress: ["api.anthropic.com", "platform.claude.com"],
    clientMeta: null,
    sessionMeta: { claudeCode: { options: { strictMcpConfig: true } } },
    modeId: "bypassPermissions",
    modelConfig: plainModel,
    isLoginFailure: (error) => error.code === authRequired || (error.code === internalError && claudeLoginData.safeParse(error.data).success),
  },
  codex: {
    adapter: ["codex-acp"],
    env: { CODEX_HOME: "/home/qa/.codex", INITIAL_AGENT_MODE: "agent-full-access", NO_BROWSER: "1" },
    mounts: (store) => [{ source: path.join(storePath(store), "auth.json"), target: "/home/qa/.codex/auth.json", readOnly: false }],
    files: [{ target: "/home/qa/.codex/config.toml", content: codexConfig }],
    tmpfs: ["/home/qa/.codex"],
    egress: ["chatgpt.com", "auth.openai.com", "api.openai.com"],
    clientMeta: null,
    sessionMeta: null,
    modeId: null,
    modelConfig: plainModel,
    isLoginFailure: (error) => error.code === authRequired || (error.code === internalError && codexLoginData.safeParse(error.data).success),
  },
  cursor: {
    adapter: ["cursor-agent", "--force", "acp"],
    env: { XDG_CONFIG_HOME: "/home/qa/.config", CURSOR_CONFIG_DIR: "/home/qa/.cursor" },
    mounts: (store) => [{ source: storePath(store), target: "/home/qa/.config/cursor", readOnly: false }],
    files: [],
    tmpfs: ["/home/qa/.config"],
    egress: ["*.cursor.sh"],
    clientMeta: { parameterizedModelPicker: true },
    sessionMeta: null,
    modeId: null,
    modelConfig: cursorModel,
    isLoginFailure: (error) => error.code === authRequired,
  },
  grok: {
    adapter: ["grok", "agent", "--always-approve", "stdio"],
    env: { GROK_AUTH_PATH: "/home/qa/.grok-login/auth.json" },
    mounts: (store) => [{ source: storePath(store), target: "/home/qa/.grok-login", readOnly: false }],
    files: [],
    tmpfs: [],
    egress: ["cli-chat-proxy.grok.com", "auth.x.ai"],
    clientMeta: null,
    sessionMeta: null,
    modeId: null,
    modelConfig: plainModel,
    isLoginFailure: (error) =>
      error.code === authRequired || error.code === rateLimited || (error.code === internalError && grokLoginData.safeParse(error.data).success),
  },
  opencode: {
    adapter: ["opencode", "acp"],
    env: {
      XDG_DATA_HOME: "/home/qa/.local/share",
      OPENCODE_DISABLE_MODELS_FETCH: "true",
      OPENCODE_DISABLE_PROJECT_CONFIG: "true",
      OPENCODE_CONFIG_CONTENT: JSON.stringify({ enabled_providers: ["opencode-go"] }),
      OPENCODE_PERMISSION: JSON.stringify({
        "*": "deny",
        ...Object.fromEntries(
          ["bash", "read", "glob", "grep", "edit", "task", "webfetch", "todowrite", "invalid", "external_directory", "doom_loop"].map((name) => [name, "allow"]),
        ),
      }),
    },
    mounts: (store) => [{ source: path.join(storePath(store), "auth.json"), target: "/home/qa/.local/share/opencode/auth.json", readOnly: true }],
    files: [],
    tmpfs: ["/home/qa/.local", "/home/qa/.local/share", "/home/qa/.local/share/opencode"],
    egress: ["opencode.ai"],
    clientMeta: null,
    sessionMeta: null,
    modeId: null,
    modelConfig: plainModel,
    isLoginFailure: () => false,
  },
};
