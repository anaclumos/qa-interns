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

export const pi = {
  adapter: ["pi-acp"],
  env: { PI_CODING_AGENT_DIR: agentDir },
  egress: ["openrouter.ai"],
  tmpfs: [agentDir],
  mounts: (credential: string): Mount[] => [{ source: credential, target: `${agentDir}/${credentialName}`, readOnly: true }],
};
