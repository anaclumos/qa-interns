import { RequestError } from "@agentclientprotocol/sdk";
import { describe, expect, test } from "bun:test";
import path from "node:path";
import { providers } from "../src/providers.ts";
import { providerNames, type Provider } from "../src/types.ts";

const authRequired = new RequestError(-32000, "Authentication required", undefined);
const cursorAuthRequired = new RequestError(-32000, "Authentication required", {
  message: "Authentication required. Please run 'agent login' first, then call authenticate() with methodId 'cursor_login'.",
});
const claudeRateLimit = new RequestError(-32603, "Internal error: You've hit your limit · resets 8pm", { errorKind: "rate_limit" });
const claudeBilling = new RequestError(-32603, "Internal error: Credit balance is too low", { errorKind: "billing_error" });
const claudeAuthFailed = new RequestError(-32603, "Internal error: Invalid API key · Please run /login", { errorKind: "authentication_failed" });
const claudeAccountOnHold = new RequestError(-32603, "Internal error: This account is on hold", { errorKind: "account_on_hold" });
const claudeOverloaded = new RequestError(-32603, "Internal error: Overloaded", { errorKind: "overloaded" });
const claudeLimitWithoutKind = new RequestError(-32603, "Internal error: You've hit your limit · resets 8pm", undefined);
const codexUsageLimit = new RequestError(-32603, "Internal error", {
  message: "You've hit your usage limit. Upgrade to Pro or try again later.",
  codexErrorInfo: "usageLimitExceeded",
});
const codexUnauthorized = new RequestError(-32603, "Internal error", {
  message: "Your access token could not be refreshed. Please log out and sign in again.",
  codexErrorInfo: "unauthorized",
});
const codexInternal = new RequestError(-32603, "Internal error", { details: "workspace routing discovery failed" });
const codexUnauthorizedStructured = new RequestError(-32603, "Internal error", { message: "Provider returned 401", codexErrorInfo: { responseStreamDisconnected: { httpStatusCode: 401 } } });
const cursorInternal = new RequestError(-32603, "Internal error", [{ expected: "string", code: "invalid_type", path: ["sessionId"], message: "Invalid input" }]);
const invalidParams = new RequestError(-32602, "Invalid params", { sessionId: { _errors: ["Invalid input: expected string, received undefined"] } });
const grokAuthRequired = new RequestError(-32000, "Authentication required", "no auth method id provided");
const grokRateLimit = new RequestError(-32003, "Rate limited", "API error (status 429 Too Many Requests): rate_limit_error: Rate limit exceeded");
const grokUsageLimit = new RequestError(-32003, "Rate limited", "API error (status 429 Too Many Requests): usage_limit_reached: You have reached your usage limit");
const grokNoCredits = new RequestError(-32603, "Internal error", {
  message: "API error (status 402 Payment Required): insufficient_quota: You have run out of credits",
  http_status: 402,
});
const grokRejectedAfterRefresh = new RequestError(-32603, "Internal error", {
  message: "Auth recovery succeeded but 4 authenticated inference requests were still rejected (401); giving up after 3 retries. Turn ran 7s wall-clock.",
  http_status: 401,
});
const grokForbidden = new RequestError(-32603, "Internal error", { message: "API error (status 403 Forbidden): permission_error: Forbidden", http_status: 403 });
const grokRefreshFailed = new RequestError(
  -32603,
  "Internal error",
  "Unauthorized (401) from https://cli-chat-proxy.grok.com/v1/responses: authentication_error: token expired\n\n  Model:     grok-4.6\n  Auth:      ApiKey\n  Version:   1.0.41\n  Available: grok-4.6, grok-4.5",
);

const opencodeApiError = new RequestError(-32603, "Internal error: Invalid API key.", { service: "session", errorName: "APIError" });
const opencodeUnknownModel = new RequestError(-32602, "Invalid params: model not found: opencode-go/glm-5.3-flash", {
  providerId: "opencode-go",
  modelId: "opencode-go/glm-5.3-flash",
});

const cases: [Provider, string, RequestError, boolean][] = [
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
  ["grok", "authentication required", grokAuthRequired, true],
  ["grok", "rate limit", grokRateLimit, true],
  ["grok", "usage limit", grokUsageLimit, true],
  ["grok", "no credits", grokNoCredits, true],
  ["grok", "rejected after a refresh", grokRejectedAfterRefresh, true],
  ["grok", "forbidden by policy", grokForbidden, false],
  ["grok", "failed refresh with text data only", grokRefreshFailed, false],
  ["grok", "the claude rate limit shape", claudeRateLimit, false],
  ["grok", "the codex usage limit shape", codexUsageLimit, false],
  ["claude", "the grok rate limit shape", grokRateLimit, false],
  ["codex", "the grok no credits shape", grokNoCredits, false],
  ["opencode", "a rejected key", opencodeApiError, false],
  ["opencode", "an unknown model", opencodeUnknownModel, false],
  ["opencode", "authentication required", authRequired, false],
];

describe("isLoginFailure", () => {
  test.each(cases)("%s: %s gives %p", (provider, _name, error, expected) => {
    expect(providers[provider].isLoginFailure(error)).toBe(expected);
  });
});

describe("mounts", () => {
  test("claude mounts the store directory as its credential store", () => {
    const mounts = providers.claude.mounts("/srv/qa-logins/claude-1");
    expect(mounts).toEqual([{ source: "/srv/qa-logins/claude-1", target: "/home/qa/.claude-login", readOnly: false }]);
    expect(providers.claude.env.CLAUDE_SECURESTORAGE_CONFIG_DIR).toBe(mounts[0]?.target);
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

  test("grok mounts the store directory and reads auth.json from it", () => {
    const mounts = providers.grok.mounts("/srv/qa-logins/grok-1");
    expect(mounts).toEqual([{ source: "/srv/qa-logins/grok-1", target: "/home/qa/.grok-login", readOnly: false }]);
    expect(providers.grok.env.GROK_AUTH_PATH).toBe(path.join(mounts[0]?.target ?? "", "auth.json"));
  });

  test("opencode mounts only auth.json from the store, read-only, into its data directory", () => {
    const mounts = providers.opencode.mounts("/srv/qa-logins/opencode-1");
    expect(mounts).toEqual([{ source: "/srv/qa-logins/opencode-1/auth.json", target: "/home/qa/.local/share/opencode/auth.json", readOnly: true }]);
    expect(path.join(providers.opencode.env.XDG_DATA_HOME ?? "", "opencode", "auth.json")).toBe(mounts[0]?.target ?? "");
  });

  test.each([...providerNames])("%s rejects a relative store", (provider) => {
    expect(() => providers[provider].mounts("logins/one")).toThrow('login store must be an absolute path, got "logins/one"');
  });

  test("the provider env points at or into every mount target", () => {
    for (const provider of providerNames) {
      const spec = providers[provider];
      const roots = Object.values(spec.env).filter((value) => value.startsWith("/"));
      for (const mount of [...spec.mounts("/srv/qa-logins/x"), ...spec.files]) {
        const related = (root: string) => mount.target === root || mount.target.startsWith(`${root}/`) || root.startsWith(`${mount.target}/`);
        expect(roots.some(related)).toBe(true);
      }
    }
  });
});

describe("modelConfig", () => {
  test("a Cursor model with parameters in brackets sets the model name, then each parameter", () => {
    expect(providers.cursor.modelConfig("grok-4.7[context=256k,reasoning_effort=high,fast=false]")).toEqual([
      { configId: "model", value: "grok-4.7" },
      { configId: "context", value: "256k" },
      { configId: "reasoning_effort", value: "high" },
      { configId: "fast", value: "false" },
    ]);
    expect(providers.cursor.modelConfig("default[]")).toEqual([{ configId: "model", value: "default" }]);
    expect(providers.cursor.modelConfig("grok-4.7")).toEqual([{ configId: "model", value: "grok-4.7" }]);
  });

  test("a Cursor model with a malformed parameter list throws", () => {
    expect(() => providers.cursor.modelConfig("grok-4.7[fast=false")).toThrow("Cursor model grok-4.7[fast=false does not end with ]");
    expect(() => providers.cursor.modelConfig("grok-4.7[fast]")).toThrow("Cursor model grok-4.7[fast] has a parameter that is not name=value: fast");
    expect(() => providers.cursor.modelConfig("grok-4.7[=false]")).toThrow("has a parameter that is not name=value: =false");
  });

  test.each(["claude", "codex", "grok", "opencode"] as const)("%s sets the model config option to the whole value", (provider) => {
    expect(providers[provider].modelConfig("model[a=b]")).toEqual([{ configId: "model", value: "model[a=b]" }]);
  });
});
