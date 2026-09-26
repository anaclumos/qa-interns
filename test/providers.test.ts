import { describe, expect, test } from "bun:test";
import { AgentError } from "../src/acp.ts";
import { providers } from "../src/providers.ts";
import type { Provider } from "../src/types.ts";

const authRequired = new AgentError(-32000, "Authentication required", undefined);
const cursorAuthRequired = new AgentError(-32000, "Authentication required", {
  message: "Authentication required. Please run 'agent login' first, then call authenticate() with methodId 'cursor_login'.",
});
const claudeRateLimit = new AgentError(-32603, "Internal error: You've hit your limit · resets 8pm", { errorKind: "rate_limit" });
const claudeBilling = new AgentError(-32603, "Internal error: Credit balance is too low", { errorKind: "billing_error" });
const claudeAuthFailed = new AgentError(-32603, "Internal error: Invalid API key · Please run /login", { errorKind: "authentication_failed" });
const claudeAccountOnHold = new AgentError(-32603, "Internal error: This account is on hold", { errorKind: "account_on_hold" });
const claudeOverloaded = new AgentError(-32603, "Internal error: Overloaded", { errorKind: "overloaded" });
const claudeLimitWithoutKind = new AgentError(-32603, "Internal error: You've hit your limit · resets 8pm", undefined);
const codexUsageLimit = new AgentError(-32603, "Internal error", {
  message: "You've hit your usage limit. Upgrade to Pro or try again later.",
  codexErrorInfo: "usageLimitExceeded",
});
const codexUnauthorized = new AgentError(-32603, "Internal error", {
  message: "Your access token could not be refreshed. Please log out and sign in again.",
  codexErrorInfo: "unauthorized",
});
const codexInternal = new AgentError(-32603, "Internal error", { details: "workspace routing discovery failed" });
const codexUnauthorizedStructured = new AgentError(-32603, "Internal error", { message: "Provider returned 401", codexErrorInfo: { responseStreamDisconnected: { httpStatusCode: 401 } } });
const cursorInternal = new AgentError(-32603, "Internal error", [{ expected: "string", code: "invalid_type", path: ["sessionId"], message: "Invalid input" }]);
const invalidParams = new AgentError(-32602, "Invalid params", { sessionId: { _errors: ["Invalid input: expected string, received undefined"] } });

const cases: [Provider, string, AgentError, boolean][] = [
  ["claude", "authentication required", authRequired, true],
  ["claude", "rate limit", claudeRateLimit, true],
  ["claude", "billing error", claudeBilling, true],
  ["claude", "authentication failed", claudeAuthFailed, true],
  ["claude", "account on hold", claudeAccountOnHold, true],
  ["claude", "overloaded", claudeOverloaded, false],
  ["claude", "limit text without an error kind", claudeLimitWithoutKind, false],
  ["claude", "the codex usage limit shape", codexUsageLimit, false],
  ["claude", "invalid params", invalidParams, false],
  ["codex", "authentication required", authRequired, true],
  ["codex", "usage limit", codexUsageLimit, true],
  ["codex", "unauthorized", codexUnauthorized, true],
  ["codex", "plain internal error", codexInternal, false],
  ["codex", "structured stream failure", codexUnauthorizedStructured, false],
  ["codex", "the claude rate limit shape", claudeRateLimit, false],
  ["cursor", "authentication required", cursorAuthRequired, true],
  ["cursor", "internal error with array data", cursorInternal, false],
  ["cursor", "the claude rate limit shape", claudeRateLimit, false],
  ["cursor", "the codex usage limit shape", codexUsageLimit, false],
];

describe("isLoginFailure", () => {
  test.each(cases)("%s: %s gives %p", (provider, _name, error, expected) => {
    expect(providers[provider].isLoginFailure(error)).toBe(expected);
  });
});

describe("mounts", () => {
  test("claude mounts the store directory as the config dir", () => {
    expect(providers.claude.mounts("/srv/qa-logins/claude-1")).toEqual([
      { source: "/srv/qa-logins/claude-1", target: "/qa/login", readOnly: false },
    ]);
  });

  test("codex mounts only auth.json from the store", () => {
    expect(providers.codex.mounts("/srv/qa-logins/codex-1/")).toEqual([
      { source: "/srv/qa-logins/codex-1/auth.json", target: "/home/qa/.codex/auth.json", readOnly: false },
    ]);
  });

  test("cursor mounts the store directory as its config dir", () => {
    expect(providers.cursor.mounts("/srv/qa-logins/cursor-1")).toEqual([
      { source: "/srv/qa-logins/cursor-1", target: "/home/qa/.config/cursor", readOnly: false },
    ]);
  });

  test.each(["claude", "codex", "cursor"] as const)("%s rejects a relative store", (provider) => {
    expect(() => providers[provider].mounts("logins/one")).toThrow('login store must be an absolute path, got "logins/one"');
  });

  test("every mount target sits under a path the provider env points at", () => {
    for (const provider of ["claude", "codex", "cursor"] as const) {
      const spec = providers[provider];
      const roots = Object.values(spec.env).filter((value) => value.startsWith("/"));
      for (const mount of [...spec.mounts("/srv/qa-logins/x"), ...spec.files]) {
        expect(roots.some((root) => mount.target.startsWith(`${root}/`) || mount.target === root)).toBe(true);
      }
    }
  });
});
