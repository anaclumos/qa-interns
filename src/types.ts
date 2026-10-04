import type { z } from "zod";
import type { relaySchema } from "./environment.ts";
import type { confirmationSchema } from "./findings.ts";
import type { storedFindingSchema } from "./report.ts";
import type { stateSchema } from "./state.ts";

export type Login = { id: string; store: string; concurrency: number; model: string | null };

export type Mount = { source: string; target: string; readOnly: boolean };

export const internStatuses = ["queued", "starting", "testing", "done", "failed", "limited"] as const;

export type InternStatus = (typeof internStatuses)[number];

export const roles = ["intern", "judge", "confirm"] as const;

export type InternState = RunState["interns"][number];

export type ContainerStats = { service: string; number: number; state: string; oomKilled: boolean; restarts: number; memoryPeak: number | null };

export type EnvironmentStats = { intern: string; startedAt: string; readyAt: string | null; containers: ContainerStats[] | null };

export const runPhases = ["preparing", "building", "starting", "up", "testing", "grouping", "confirming", "reporting", "done", "failed"] as const;

export type RunPhase = (typeof runPhases)[number];

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
  confirmation: { intern: string; result: Confirmation | null; error: string | null } | null;
};

export type Replay = { runId: string; target: RunState["target"]; groups: Group[] };
