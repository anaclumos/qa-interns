import { stripControl } from "./findings.ts";
import type { Group, InternState, Rejected, RunState } from "./types.ts";

export function reproductions(group: Group): string[] {
  const interns = new Set(group.findings.map((finding) => finding.intern));
  if (group.confirmation?.result?.reproduced) interns.add(group.confirmation.intern);
  return [...interns];
}

function quote(text: string, indent = "") {
  return text.split("\n").map((line) => `${indent}> ${line}`);
}

function cell(value: string | number | null) {
  return String(value ?? "").split("\n").join(" ").split("|").join("\\|");
}

function paths(list: string[]) {
  return list.length > 0 ? list.map((entry) => `- \`${entry}\``) : ["No evidence files."];
}

function confirmation(group: Group) {
  const outcome = group.confirmation;
  if (outcome === null) return ["Confirmation: not attempted."];
  const who = outcome.provider === null ? outcome.intern : `${outcome.intern} (${outcome.provider})`;
  if (outcome.error !== null) return [`Confirmation: ${who} failed: ${outcome.error}`];
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
    `### ${first.title}`,
    "",
    `- Kind: ${first.kind}`,
    `- Reproductions: ${interns.length} (${interns.join(", ")})`,
    "- Conditions:",
    `  - Account: ${first.conditions.account}`,
    `  - Data: ${first.conditions.data}`,
    `  - Viewport: ${first.conditions.viewport}`,
    `  - Browser: ${first.conditions.browser}`,
    `  - Network: ${first.conditions.network}`,
    "",
    "Steps:",
    "",
    ...first.steps.map((step, index) => `${index + 1}. ${step.split("\n").join("\n   ")}`),
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
    for (const finding of others) lines.push(`- ${finding.id}`, ...quote(finding.observed, "  "));
    lines.push("");
  }
  lines.push(...confirmation(group), "");
  return lines;
}

export function renderReport(state: RunState, groups: Group[], rejected: Rejected[]): { markdown: string; json: unknown } {
  const rows = groups.map((group) => ({ group, interns: reproductions(group) }));
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
  if (state.error !== null) lines.push(`- Error: ${state.error}`);
  lines.push("", "## Confirmed", "");
  if (confirmed.length === 0) lines.push("No finding was reproduced twice.", "");
  for (const row of confirmed) lines.push(...section(row.group, row.interns));
  lines.push("## Seen once", "");
  if (seenOnce.length === 0) lines.push("No finding was seen only once.", "");
  for (const row of seenOnce) lines.push(...section(row.group, row.interns));
  lines.push("## Rejected finding files", "");
  if (rejected.length === 0) lines.push("No finding file was rejected.");
  for (const entry of rejected) lines.push(`- \`${entry.file}\`: ${entry.reason}`);
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
    },
  };
}
