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
  sessionMeta: Record<string, unknown> | null;
  modeId: string | null;
  isLoginFailure(error: RequestError): boolean;
};

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

export const providers: Record<Provider, ProviderSpec> = {
  claude: {
    adapter: ["claude-agent-acp"],
    env: {
      CLAUDE_CONFIG_DIR: "/home/qa/.claude",
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      ENABLE_CLAUDEAI_MCP_SERVERS: "false",
      DISABLE_AUTOUPDATER: "1",
    },
    mounts: (store) => [{ source: path.join(storePath(store), ".credentials.json"), target: "/home/qa/.claude/.credentials.json", readOnly: false }],
    files: [],
    tmpfs: ["/home/qa/.claude"],
    egress: ["api.anthropic.com", "platform.claude.com"],
    sessionMeta: { claudeCode: { options: { strictMcpConfig: true } } },
    modeId: "bypassPermissions",
    isLoginFailure: (error) => error.code === authRequired || (error.code === internalError && claudeLoginData.safeParse(error.data).success),
  },
  codex: {
    adapter: ["codex-acp"],
    env: { CODEX_HOME: "/home/qa/.codex", INITIAL_AGENT_MODE: "agent-full-access", NO_BROWSER: "1" },
    mounts: (store) => [{ source: path.join(storePath(store), "auth.json"), target: "/home/qa/.codex/auth.json", readOnly: false }],
    files: [{ target: "/home/qa/.codex/config.toml", content: codexConfig }],
    tmpfs: ["/home/qa/.codex"],
    egress: ["chatgpt.com", "auth.openai.com", "api.openai.com"],
    sessionMeta: null,
    modeId: null,
    isLoginFailure: (error) => error.code === authRequired || (error.code === internalError && codexLoginData.safeParse(error.data).success),
  },
  cursor: {
    adapter: ["cursor-agent", "--force", "acp"],
    env: { XDG_CONFIG_HOME: "/home/qa/.config", CURSOR_CONFIG_DIR: "/home/qa/.cursor" },
    mounts: (store) => [{ source: storePath(store), target: "/home/qa/.config/cursor", readOnly: false }],
    files: [],
    tmpfs: ["/home/qa/.config"],
    egress: ["*.cursor.sh"],
    sessionMeta: null,
    modeId: null,
    isLoginFailure: (error) => error.code === authRequired,
  },
  grok: {
    adapter: ["grok", "agent", "--always-approve", "stdio"],
    env: { GROK_AUTH_PATH: "/home/qa/.grok-login/auth.json" },
    mounts: (store) => [{ source: storePath(store), target: "/home/qa/.grok-login", readOnly: false }],
    files: [],
    tmpfs: [],
    egress: ["cli-chat-proxy.grok.com", "auth.x.ai"],
    sessionMeta: null,
    modeId: null,
    isLoginFailure: (error) =>
      error.code === authRequired || error.code === rateLimited || (error.code === internalError && grokLoginData.safeParse(error.data).success),
  },
};
