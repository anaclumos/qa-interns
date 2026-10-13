import { readFileSync } from "node:fs";
import { z } from "zod";
import { minLength } from "./secrets.ts";
import type { RunnerFile } from "./types.ts";

const agentDir = "/home/qa/.pi";

export const credentialName = "auth.json";

export const credentialRule = `must hold one OpenRouter API key of at least ${minLength} characters and nothing else`;

const authSchema = z.strictObject({
  openrouter: z.strictObject({
    type: z.literal("api_key"),
    key: z
      .string()
      .min(minLength)
      .refine((key) => !key.startsWith("!") && !key.includes("$")),
  }),
});

export function readKey(file: string): string | null {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    if (error instanceof SyntaxError) return null;
    throw error;
  }
  return authSchema.safeParse(value).data?.openrouter.key ?? null;
}

const keyUrl = "https://openrouter.ai/api/v1/key";

const keySchema = z.looseObject({
  data: z.looseObject({
    effective_budget: z
      .looseObject({ scope: z.string(), limit_usd: z.number(), spend_usd: z.number(), remaining_usd: z.number(), resets_at: z.string().nullable() })
      .nullable(),
  }),
});

export async function keyProblem(key: string): Promise<string | null> {
  const response = await fetch(keyUrl, { headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(30_000) });
  if (response.status !== 200) return `${keyUrl} answered ${response.status}`;
  const budget = keySchema.parse(await response.json()).data.effective_budget;
  if (budget === null || budget.remaining_usd > 0) return null;
  return `the OpenRouter ${budget.scope} budget is spent, $${budget.spend_usd} of $${budget.limit_usd}, ${budget.resets_at === null ? "and never resets" : `until ${budget.resets_at}`}`;
}

export const pi = {
  adapter: ["pi-acp"],
  model: "openrouter/anthropic/claude-haiku-5.5",
  env: { PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1" },
  egress: ["openrouter.ai"],
  tmpfs: [agentDir],
  files: (credential: string): RunnerFile[] => [{ source: credential, target: `${agentDir}/${credentialName}` }],
};

const completionsUrl = "https://openrouter.ai/api/v1/chat/completions";

const errorSchema = z.looseObject({
  error: z.looseObject({
    message: z.string(),
    metadata: z.looseObject({ raw: z.unknown().optional() }).optional(),
  }),
});

const rawSchema = z.looseObject({ error: z.looseObject({ message: z.string() }) });

const choicesSchema = z.looseObject({
  choices: z
    .array(
      z.looseObject({
        finish_reason: z.string().refine((reason) => reason !== "error"),
        message: z.looseObject({ role: z.literal("assistant") }),
      }),
    )
    .nonempty(),
});

function parseJson(text: string): { value: unknown } | null {
  try {
    return { value: JSON.parse(text) };
  } catch (error) {
    if (error instanceof SyntaxError) return null;
    throw error;
  }
}

export function completionProblem(status: number, text: string): string | null {
  const body = parseJson(text);
  if (body === null) return `${completionsUrl} answered ${status} with a body that is not JSON`;
  const failed = errorSchema.safeParse(body.value);
  if (failed.success) {
    const { message, metadata } = failed.data.error;
    const raw = typeof metadata?.raw === "string" ? parseJson(metadata.raw) : { value: metadata?.raw };
    const provider = raw === null ? null : (rawSchema.safeParse(raw.value).data?.error.message ?? null);
    return `the model provider refused a one-token request: ${provider ?? message}`;
  }
  if (status !== 200) return `${completionsUrl} answered ${status}`;
  if (!choicesSchema.safeParse(body.value).success) return `${completionsUrl} answered 200 without a completion choice`;
  return null;
}

export async function providerProblem(key: string): Promise<string | null> {
  const response = await fetch(completionsUrl, {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({ model: pi.model.slice("openrouter/".length), max_tokens: 1, messages: [{ role: "user", content: "hi" }] }),
    signal: AbortSignal.timeout(60_000),
  });
  return completionProblem(response.status, await response.text());
}
