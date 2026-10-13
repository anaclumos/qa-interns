import { describe, expect, test } from "bun:test";
import { providerError } from "../src/pi.ts";

describe("providerError", () => {
  test("returns null for a completion with choices and no error", () => {
    const body = { id: "gen-1", model: "anthropic/claude-haiku-5.5", choices: [{ message: { role: "assistant", content: "ok" } }] };
    expect(providerError(body)).toBeNull();
  });

  test("returns the provider message inside metadata.raw for a BYOK refusal", () => {
    const raw = JSON.stringify({
      type: "error",
      error: {
        type: "invalid_request_error",
        message: "Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.",
      },
      request_id: "req_test",
    });
    const body = { error: { message: "Provider returned error", code: 400, metadata: { raw, provider_name: "Anthropic", is_byok: true } } };
    expect(providerError(body)).toBe("Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.");
  });

  test("returns the top-level message when there is no raw provider body", () => {
    const body = { error: { message: "Key limit exceeded", code: 403 } };
    expect(providerError(body)).toBe("Key limit exceeded");
  });

  test("returns null for a body that is not a completion error shape", () => {
    expect(providerError({ error: { code: 1 } })).toBeNull();
    expect(providerError(null)).toBeNull();
    expect(providerError("not json")).toBeNull();
  });
});
