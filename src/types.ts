export type Provider = "claude" | "codex" | "cursor" | "grok";

export type Login = { id: string; provider: Provider; store: string | null; seat: string[] | null; concurrency: number };

export type Mount = { source: string; target: string; readOnly: boolean };

export type GeneratedFile = { target: string; content: string };

export type InternStatus = "queued" | "starting" | "testing" | "done" | "failed" | "limited";

export type InternState = {
  id: string;
  role: "intern" | "judge" | "confirm";
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

export type RunPhase = "preparing" | "building" | "testing" | "grouping" | "confirming" | "reporting" | "done" | "failed";

export type RunState = {
  runId: string;
  pid: number;
  pidStart: number;
  target: { repo: string; path: string; commit: string };
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

export type FindingEnvironment = { commit: string; environment: string; provider: Provider; model: string | null };

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

export type Group = {
  id: string;
  findings: Finding[];
  confirmation: { intern: string; provider: Provider | null; result: Confirmation | null; error: string | null } | null;
};

export type Replay = { runId: string; target: RunState["target"]; groups: Group[] };
