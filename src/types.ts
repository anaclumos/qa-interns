export const providerNames = ["claude", "codex", "cursor", "grok"] as const;

export type Provider = (typeof providerNames)[number];

export type Login = { id: string; provider: Provider; store: string | null; seat: string[] | null; concurrency: number };

export type Mount = { source: string; target: string; readOnly: boolean };

export type GeneratedFile = { target: string; content: string };

export const internStatuses = ["queued", "starting", "testing", "done", "failed", "limited"] as const;

export type InternStatus = (typeof internStatuses)[number];

export const roles = ["intern", "judge", "confirm"] as const;

export type InternState = {
  id: string;
  role: (typeof roles)[number];
  charter: string;
  group: string | null;
  provider: Provider | null;
  login: string | null;
  model: string | null;
  project: string | null;
  status: InternStatus;
  detail: string | null;
  findings: number;
  rejected: number;
  startedAt: string | null;
  endedAt: string | null;
};

export type ContainerStats = { service: string; number: number; state: string; oomKilled: boolean; restarts: number; memoryPeak: number | null };

export type EnvironmentStats = { intern: string; attempt: number; startedAt: string; readyAt: string | null; containers: ContainerStats[] | null };

export const runPhases = ["preparing", "building", "starting", "up", "testing", "grouping", "confirming", "reporting", "done", "failed"] as const;

export type RunPhase = (typeof runPhases)[number];

export type RunState = {
  runId: string;
  pid: number;
  pidStart: number;
  target: { repo: string; path: string; commit: string; dirty: boolean };
  options: { interns: number; minutes: number; confirmMinutes: number; concurrency: number };
  phase: RunPhase;
  error: string | null;
  startedAt: string;
  updatedAt: string;
  endedAt: string | null;
  interns: InternState[];
};

export const kinds = ["crash", "error", "wrong-data", "data-loss", "inconsistency", "access", "visual", "slow"] as const;

export type Kind = (typeof kinds)[number];

export type FindingEnvironment = { commit: string; dirty: boolean; environment: string; provider: Provider; model: string | null };

export type Finding = {
  id: string;
  intern: string;
  title: string;
  kind: Kind;
  conditions: { account: string; data: string; viewport: string; browser: string; network: string };
  steps: string[];
  observed: string;
  contradicts: string | null;
  evidence: string[];
  environment: FindingEnvironment;
};

export type Rejected = { intern: string; file: string; reason: string };

export type Confirmation = { reproduced: boolean; observed: string; evidence: string[] };

export const relayOutcomes = ["connected", "failed", "denied", "refused", "incomplete"] as const;

export type RelayRecord = { n: number; host: string | null; outcome: (typeof relayOutcomes)[number]; error: string | null };

export type Group = {
  id: string;
  findings: Finding[];
  confirmation: { intern: string; provider: Provider | null; result: Confirmation | null; error: string | null } | null;
};

export type Replay = { runId: string; target: RunState["target"]; groups: Group[] };
