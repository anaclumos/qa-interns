import { stripControl } from "./findings.ts";
import type { Group, InternState, RelayRecord, Rejected, RunState } from "./types.ts";

export type Egress = { hosts: string[]; relays: { intern: string; records: RelayRecord[] }[] };

type EgressRow = { host: string | null; outcome: RelayRecord["outcome"] | "unrecorded" | null; error: string | null; connections: number; interns: string[] };

export function reproductions(group: Group): string[] {
  const interns = new Set(group.findings.map((finding) => finding.intern));
  if (group.confirmation?.result?.reproduced) interns.add(group.confirmation.intern);
  return [...interns];
}

function egressRows({ hosts, relays }: Egress): EgressRow[] {
  const rows = new Map<string, EgressRow>();
  const add = (intern: string, host: string | null, outcome: EgressRow["outcome"], error: string | null, connections: number) => {
    const key = JSON.stringify([host, outcome, error]);
    const row = rows.get(key) ?? { host, outcome, error, connections: 0, interns: [] };
    row.connections += connections;
    if (!row.interns.includes(intern)) row.interns.push(intern);
    rows.set(key, row);
  };
  for (const { intern, records } of relays) {
    let previous = 0;
    for (const record of records) {
      if (record.n > 1 && record.n !== previous + 1) add(intern, null, "unrecorded", null, record.n - 1);
      previous = record.n;
      add(intern, record.host, record.outcome, record.error, 1);
    }
  }
  const contacted = new Set([...rows.values()].map((row) => row.host));
  const silent = hosts.filter((host) => !contacted.has(host)).map((host): EgressRow => ({ host, outcome: null, error: null, connections: 0, interns: [] }));
  const rank = (row: EgressRow) => (row.host === null ? hosts.length + 1 : hosts.includes(row.host) ? hosts.indexOf(row.host) : hosts.length);
  return [...rows.values(), ...silent].sort((a, b) => rank(a) - rank(b));
}

const markdown = new Set(["\\", "`", "*", "_", "[", "]", "!", "#", "|", "~"]);

function escape(text: string) {
  let out = "";
  for (const char of text) out += char === "<" ? "&lt;" : char === ">" ? "&gt;" : markdown.has(char) ? `\\${char}` : char;
  return out;
}

function inline(text: string) {
  return escape(text).split("\n").join(" ");
}

function quote(text: string, indent = "") {
  return escape(text).split("\n").map((line) => `${indent}> ${line}`);
}

function item(marker: string, text: string) {
  return `${marker}${escape(text).split("\n").join(`\n${" ".repeat(marker.length)}`)}`;
}

function cell(value: string | number | null) {
  return inline(String(value ?? ""));
}

function paths(list: string[]) {
  return list.length > 0 ? list.map((entry) => `- ${inline(entry)}`) : ["No evidence files."];
}

function confirmation(group: Group) {
  const outcome = group.confirmation;
  if (outcome === null) return ["Confirmation: not attempted."];
  const who = outcome.provider === null ? outcome.intern : `${outcome.intern} (${outcome.provider})`;
  if (outcome.error !== null) return [`Confirmation: ${who} failed: ${inline(outcome.error)}`];
  if (outcome.result === null) return [`Confirmation: ${who} recorded no result.`];
  return [
    `Confirmation: ${who} ${outcome.result.reproduced ? "reproduced it" : "did not reproduce it"}.`,
    "",
    ...quote(outcome.result.observed),
    "",
    "Confirmation evidence:",
    "",
    ...paths(outcome.result.evidence),
  ];
}

function section(group: Group, interns: string[]) {
  const [first, ...others] = group.findings;
  if (first === undefined) throw new Error(`group ${group.id} has no findings`);
  const lines = [
    `### ${inline(first.title)}`,
    "",
    `- Kind: ${first.kind}`,
    `- Reproductions: ${interns.length} (${interns.join(", ")})`,
    "- Conditions:",
    `  - Account: ${inline(first.conditions.account)}`,
    `  - Data: ${inline(first.conditions.data)}`,
    `  - Viewport: ${inline(first.conditions.viewport)}`,
    `  - Browser: ${inline(first.conditions.browser)}`,
    `  - Network: ${inline(first.conditions.network)}`,
    "",
    "Steps:",
    "",
    ...first.steps.map((step, index) => item(`${index + 1}. `, step)),
    "",
    "Observed:",
    "",
    ...quote(first.observed),
    "",
  ];
  if (first.contradicts !== null) lines.push("Contradicts:", "", ...quote(first.contradicts), "");
  lines.push("Evidence:", "", ...paths(first.evidence), "");
  if (others.length > 0) {
    lines.push("Other reports:", "");
    for (const finding of others) lines.push(`- ${inline(finding.id)}`, ...quote(finding.observed, "  "));
    lines.push("");
  }
  lines.push(...confirmation(group), "");
  return lines;
}

export function renderReport(state: RunState, groups: Group[], rejected: Rejected[], egress: Egress): { markdown: string; json: unknown } {
  const rows = groups.map((group) => ({ group, interns: reproductions(group) }));
  const connections = egressRows(egress);
  const confirmed = rows.filter((row) => row.interns.length >= 2);
  const seenOnce = rows.filter((row) => row.interns.length < 2);
  const role = (name: InternState["role"]) => state.interns.filter((intern) => intern.role === name).length;
  const summary = {
    runId: state.runId,
    target: state.target,
    phase: state.phase,
    error: state.error,
    startedAt: state.startedAt,
    endedAt: state.endedAt,
    interns: { testing: role("intern"), confirming: role("confirm"), judging: role("judge") },
    providers: [...new Set(state.interns.flatMap((intern) => (intern.provider === null ? [] : [intern.provider])))],
    confirmedGroups: confirmed.length,
    seenOnceGroups: seenOnce.length,
    rejectedFiles: rejected.length,
  };

  const lines = [
    `# QA Interns run ${state.runId}`,
    "",
    `- Target: \`${state.target.repo}\`, path \`${state.target.path || "."}\``,
    `- Commit: \`${state.target.commit}\``,
    `- Ran: ${state.startedAt}${state.endedAt === null ? "" : ` to ${state.endedAt}`}`,
    `- Interns: ${summary.interns.testing} testing, ${summary.interns.confirming} confirming, ${summary.interns.judging} judging`,
    `- Providers: ${summary.providers.length > 0 ? summary.providers.join(", ") : "none"}`,
    `- Confirmed groups: ${summary.confirmedGroups}`,
    `- Groups seen once: ${summary.seenOnceGroups}`,
    `- Rejected finding files: ${summary.rejectedFiles}`,
  ];
  if (state.error !== null) lines.push(`- Error: ${inline(state.error)}`);
  lines.push("", "## Confirmed", "");
  if (confirmed.length === 0) lines.push("No finding was reproduced twice.", "");
  for (const row of confirmed) lines.push(...section(row.group, row.interns));
  lines.push("## Seen once", "");
  if (seenOnce.length === 0) lines.push("No finding was seen only once.", "");
  for (const row of seenOnce) lines.push(...section(row.group, row.interns));
  lines.push("## Rejected finding files", "");
  if (rejected.length === 0) lines.push("No finding file was rejected.");
  for (const entry of rejected) lines.push(`- ${inline(entry.file)}: ${inline(entry.reason)}`);
  lines.push("", "## Interns", "");
  if (state.interns.length === 0) lines.push("No intern ran.");
  else {
    lines.push("| Id | Role | Provider | Model | Status | Findings | Detail |", "| --- | --- | --- | --- | --- | --- | --- |");
    for (const intern of state.interns) {
      lines.push(
        `| ${[intern.id, intern.role, intern.provider, intern.model, intern.status, intern.findings, intern.detail].map(cell).join(" | ")} |`,
      );
    }
  }
  lines.push("", "## Egress connections", "");
  if (connections.length === 0) lines.push("No connection went through a relay.");
  else {
    lines.push("| Host | Outcome | Error | Connections | Interns |", "| --- | --- | --- | --- | --- |");
    for (const row of connections) {
      lines.push(`| ${[row.host, row.outcome ?? "no connection", row.error, row.connections, row.interns.join(", ")].map(cell).join(" | ")} |`);
    }
  }

  return {
    markdown: stripControl(`${lines.join("\n")}\n`),
    json: {
      run: summary,
      groups: [...confirmed, ...seenOnce].map((row) => ({
        id: row.group.id,
        confirmed: row.interns.length >= 2,
        reproductions: row.interns,
        findings: row.group.findings,
        confirmation: row.group.confirmation,
      })),
      rejected,
      interns: state.interns,
      egress: connections,
    },
  };
}
