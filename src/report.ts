import path from "node:path";
import { linkEvidence, stripControl } from "./findings.ts";
import type { Group, InternState, Rejected, RunState } from "./types.ts";

type Ticket = { id: string; title: string; body: string; evidence: string[] };

export function reproductions(group: Group): string[] {
  const interns = new Set(group.findings.map((finding) => finding.intern));
  if (group.confirmation?.result?.reproduced) interns.add(group.confirmation.intern);
  return [...interns];
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
  return `${marker}${text.split("\n").join(`\n${" ".repeat(marker.length)}`)}`;
}

function block(text: string) {
  const clean = stripControl(text);
  let run = 0;
  let longest = 0;
  for (const char of clean) {
    run = char === "`" ? run + 1 : 0;
    longest = Math.max(longest, run);
  }
  const fence = "`".repeat(Math.max(3, longest + 1));
  return [fence, ...clean.split("\n"), fence];
}

function files(list: string[]) {
  return list.length > 0 ? block(list.join("\n")) : ["No evidence files."];
}

function who(outcome: NonNullable<Group["confirmation"]>) {
  return outcome.provider === null ? outcome.intern : `${outcome.intern} (${outcome.provider})`;
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
  if (outcome.error !== null) return [`Confirmation: ${who(outcome)} failed: ${inline(outcome.error)}`];
  if (outcome.result === null) return [`Confirmation: ${who(outcome)} recorded no result.`];
  return [
    `Confirmation: ${who(outcome)} ${outcome.result.reproduced ? "reproduced it" : "did not reproduce it"}.`,
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
    ...first.steps.map((step, index) => item(`${index + 1}. `, escape(step))),
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

function ticket(state: RunState, group: Group, interns: string[]): Ticket {
  const [first, ...others] = group.findings;
  if (first === undefined) throw new Error(`group ${group.id} has no findings`);
  const { account, data, viewport, browser, network } = first.conditions;
  const lines = [
    `- Run: ${state.runId}`,
    `- Commit: ${state.target.commit}`,
    `- Kind: ${first.kind}`,
    `- Reproductions: ${interns.length} (${interns.join(", ")})`,
    "",
    "## Conditions",
    "",
    ...block([`Account: ${account}`, `Data: ${data}`, `Viewport: ${viewport}`, `Browser: ${browser}`, `Network: ${network}`].join("\n")),
    "",
    "## Steps",
    "",
    ...block(first.steps.map((step, index) => item(`${index + 1}. `, step)).join("\n")),
    "",
    "## Observed",
    "",
    ...block(first.observed),
    "",
  ];
  if (first.contradicts !== null) lines.push("## Contradicts", "", ...block(first.contradicts), "");
  lines.push("## Evidence", "", ...files(first.evidence), "");
  if (others.length > 0) {
    lines.push("## Other reports", "");
    for (const finding of others) lines.push(`${finding.intern}:`, "", ...block(finding.observed), "");
  }
  lines.push("## Confirmation", "");
  const outcome = group.confirmation;
  if (outcome === null) lines.push("Not attempted.", "");
  else if (outcome.error !== null) lines.push(`${who(outcome)} failed:`, "", ...block(outcome.error), "");
  else if (outcome.result === null) lines.push(`${who(outcome)} recorded no result.`, "");
  else {
    lines.push(`${who(outcome)} ${outcome.result.reproduced ? "reproduced it" : "did not reproduce it"}.`, "", ...block(outcome.result.observed), "");
    lines.push("Confirmation evidence:", "", ...files(outcome.result.evidence), "");
  }
  const evidence = [...new Set([...first.evidence, ...(outcome?.result?.evidence ?? [])])];
  return { id: group.id, title: first.title, body: lines.join("\n"), evidence };
}

export async function writeTickets(runDir: string, tickets: Ticket[]): Promise<void> {
  for (const draft of tickets) {
    const dir = path.join(runDir, "tickets", draft.id);
    const missing: string[] = [];
    for (const entry of draft.evidence) {
      const reason = await linkEvidence(runDir, entry, path.join(dir, entry));
      if (reason !== null) missing.push(`${entry}: ${reason}`);
    }
    const body = missing.length === 0 ? draft.body : [draft.body, "## Evidence not in this folder", "", ...block(missing.join("\n")), ""].join("\n");
    await Bun.write(path.join(dir, "title.txt"), `${draft.title}\n`);
    await Bun.write(path.join(dir, "body.md"), body);
  }
}

export function renderReport(state: RunState, groups: Group[], rejected: Rejected[]): { markdown: string; json: unknown; tickets: Ticket[] } {
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
    tickets: confirmed.map((row) => ticket(state, row.group, row.interns)),
  };
}
