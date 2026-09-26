import path from "node:path";
import type { AgentError } from "./acp.ts";
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
  isLoginFailure(error: AgentError): boolean;
};

const authRequired = -32000;
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
    isLoginFailure: (error) => {
      if (error.code === authRequired) return true;
      const data = error.data;
      return (
        error.code === internalError &&
        typeof data === "object" &&
        data !== null &&
        "errorKind" in data &&
        typeof data.errorKind === "string" &&
        claudeLoginKinds.includes(data.errorKind)
      );
    },
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
    isLoginFailure: (error) => {
      if (error.code === authRequired) return true;
      const data = error.data;
      return (
        error.code === internalError &&
        typeof data === "object" &&
        data !== null &&
        "codexErrorInfo" in data &&
        typeof data.codexErrorInfo === "string" &&
        codexLoginErrors.includes(data.codexErrorInfo)
      );
    },
  },
  cursor: {
    adapter: ["agent", "acp"],
    env: { XDG_CONFIG_HOME: "/home/qa/.config" },
    mounts: (store) => [{ source: storePath(store), target: "/home/qa/.config/cursor", readOnly: false }],
    files: [],
    tmpfs: ["/home/qa/.config"],
    egress: ["*.cursor.sh"],
    sessionMeta: null,
    modeId: null,
    isLoginFailure: (error) => error.code === authRequired,
  },
};
