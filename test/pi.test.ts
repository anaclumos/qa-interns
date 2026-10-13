import { describe, expect, test } from "bun:test";
import { completionProblem } from "../src/pi.ts";

const url = "https://openrouter.ai/api/v1/chat/completions";
const refused = "the model provider refused a one-token request: ";

describe("completionProblem", () => {
  test("passes a 200 completion with a choice", () => {
    const body = { id: "gen-1", model: "anthropic/claude-haiku-5.5", choices: [{ finish_reason: "length", message: { role: "assistant", content: "ok" } }] };
    expect(completionProblem(200, JSON.stringify(body))).toBeNull();
  });

  test("fails a 200 body whose choice is null, empty, or failed", () => {
    for (const choice of [null, {}, { finish_reason: "error", message: { role: "assistant", content: null } }, { finish_reason: "stop" }]) {
      expect(completionProblem(200, JSON.stringify({ choices: [choice] }))).toBe(`${url} answered 200 without a completion choice`);
    }
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
    expect(completionProblem(400, JSON.stringify(body))).toBe(
      `${refused}Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.`,
    );
  });

  test("returns the top-level message when metadata has no raw body or a raw body that is not an error", () => {
    expect(completionProblem(403, JSON.stringify({ error: { message: "Key limit exceeded", code: 403 } }))).toBe(`${refused}Key limit exceeded`);
    expect(completionProblem(502, JSON.stringify({ error: { message: "Upstream failed", metadata: { provider_name: "Anthropic" } } }))).toBe(`${refused}Upstream failed`);
    expect(completionProblem(502, JSON.stringify({ error: { message: "Upstream failed", metadata: { raw: "<html>" } } }))).toBe(`${refused}Upstream failed`);
    expect(completionProblem(502, JSON.stringify({ error: { message: "Upstream failed", metadata: { raw: 42 } } }))).toBe(`${refused}Upstream failed`);
  });

  test("returns the provider message from a metadata.raw object", () => {
    const body = { error: { message: "Provider returned error", metadata: { raw: { error: { message: "credit balance too low" } } } } };
    expect(completionProblem(400, JSON.stringify(body))).toBe(`${refused}credit balance too low`);
    expect(completionProblem(200, JSON.stringify(body))).toBe(`${refused}credit balance too low`);
  });

  test("fails an error inside a 200 body", () => {
    expect(completionProblem(200, JSON.stringify({ error: { message: "Provider returned error" } }))).toBe(`${refused}Provider returned error`);
  });

  test("fails a 200 body that is truncated, empty, or has no choice", () => {
    expect(completionProblem(200, '{"choices": [')).toBe(`${url} answered 200 with a body that is not JSON`);
    expect(completionProblem(200, "{}")).toBe(`${url} answered 200 without a completion choice`);
    expect(completionProblem(200, JSON.stringify({ choices: [] }))).toBe(`${url} answered 200 without a completion choice`);
  });

  test("fails a non-200 status without an error body", () => {
    expect(completionProblem(503, JSON.stringify({ error: { code: 1 } }))).toBe(`${url} answered 503`);
    expect(completionProblem(503, "Service Unavailable")).toBe(`${url} answered 503 with a body that is not JSON`);
  });
});
