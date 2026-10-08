import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { minLength } from "./secrets.ts";
import type { Mount } from "./types.ts";

const agentDir = "/home/qa/.pi";

export const credentialName = "auth.json";

const models = join(import.meta.dir, "..", "runner", "pi-models.json");

export const credentialRule = `must hold one Vercel AI Gateway API key of at least ${minLength} characters and nothing else`;

const authSchema = z.strictObject({
  "vercel-ai-gateway": z.strictObject({
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
  return authSchema.safeParse(value).data?.["vercel-ai-gateway"].key ?? null;
}

export const pi = {
  adapter: ["pi-acp"],
  model: "vercel-ai-gateway/anthropic/claude-haiku-5.5",
  env: { PI_CODING_AGENT_DIR: agentDir },
  egress: ["ai-gateway.vercel.sh"],
  tmpfs: [agentDir],
  mounts: (credential: string): Mount[] => [
    { source: credential, target: `${agentDir}/${credentialName}`, readOnly: true },
    { source: models, target: `${agentDir}/models.json`, readOnly: true },
  ],
};
