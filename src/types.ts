import type { z } from "zod";
import type { relaySchema } from "./environment.ts";
import type { confirmationSchema } from "./findings.ts";
import type { storedFindingSchema } from "./report.ts";
import type { stateSchema } from "./state.ts";

export type Provider = "claude" | "codex" | "cursor" | "grok";

export type Login = { id: string; provider: Provider; store: string | null; seat: string[] | null; concurrency: number };

export type Mount = { source: string; target: string; readOnly: boolean };

export type GeneratedFile = { target: string; content: string };

export type InternStatus = "queued" | "starting" | "testing" | "done" | "failed" | "limited";

export type InternState = RunState["interns"][number];

export type ContainerStats = { service: string; number: number; state: string; oomKilled: boolean; restarts: number; memoryPeak: number | null };

export type EnvironmentStats = { intern: string; attempt: number; startedAt: string; readyAt: string | null; containers: ContainerStats[] | null };

export type RunPhase = "preparing" | "building" | "starting" | "up" | "testing" | "grouping" | "confirming" | "reporting" | "done" | "failed";

export type RunState = z.infer<typeof stateSchema>;

export const kinds = ["crash", "error", "wrong-data", "data-loss", "inconsistency", "access", "visual", "slow"] as const;

export type Kind = (typeof kinds)[number];

export type FindingEnvironment = Finding["environment"];

export type Finding = z.infer<typeof storedFindingSchema>;

export type Rejected = { intern: string; file: string; reason: string };

export type Confirmation = z.infer<typeof confirmationSchema>;

export const relayOutcomes = ["connected", "failed", "denied", "refused", "incomplete"] as const;

export type RelayRecord = z.infer<typeof relaySchema>;

export type Group = {
  id: string;
  findings: Finding[];
  confirmation: { intern: string; provider: Provider | null; result: Confirmation | null; error: string | null } | null;
};

export type Replay = { runId: string; target: RunState["target"]; groups: Group[] };
