import { readFileSync } from "node:fs";
import { z } from "zod";
import { minLength } from "./secrets.ts";
import type { Mount } from "./types.ts";

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
  mounts: (credential: string): Mount[] => [{ source: credential, target: `${agentDir}/${credentialName}`, readOnly: true }],
};
