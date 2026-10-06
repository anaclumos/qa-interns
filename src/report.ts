import { basename, extname, join, resolve } from "node:path";
import { z } from "zod";
import { linkEvidence, stripControl } from "./findings.ts";
import { readJson, readState } from "./state.ts";
import { kinds, providerNames, type Confirmation, type EnvironmentStats, type Finding, type Group, type InternState, type RelayRecord, type Rejected, type Replay, type RunState } from "./types.ts";

export type Egress = { hosts: string[]; relays: { intern: string; records: RelayRecord[] }[] };

type EgressRow = { host: string | null; outcome: RelayRecord["outcome"] | "unrecorded" | null; error: string | null; connections: number; interns: string[] };

type Ticket = { id: string; title: string; body: string; evidence: string[] };

export function confirms(result: Confirmation): boolean {
  return result.steps && result.task;
}

export function reproductions(group: Group): string[] {
  const interns = new Set(group.findings.map((finding) => finding.intern));
  const outcome = group.confirmation;
  if (outcome?.result && confirms(outcome.result)) interns.add(outcome.intern);
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

const imageTypes = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg"]);

function destination(file: string) {
  return file
    .split("/")
    .map((part) => encodeURIComponent(part).replaceAll("(", "%28").replaceAll(")", "%29"))
    .join("/");
}

function images(list: string[], root: string) {
  return list.filter((entry) => imageTypes.has(extname(entry).toLowerCase())).flatMap((entry) => ["", `![${inline(basename(entry))}](${destination(join(root, entry))})`]);
}

function wrongSteps(group: Group) {
  const result = group.confirmation?.result ?? null;
  return result !== null && result.steps && !result.task;
}

function verdict(result: Confirmation) {
  const shown = (value: boolean) => (value ? "showed" : "did not show");
  return `${confirms(result) ? "reproduced it" : "did not reproduce it"}: the steps ${shown(result.steps)} the failure, and the task done through the page's own controls ${shown(result.task)} it`;
}

function confirmation(group: Group, root: string) {
  const outcome = group.confirmation;
  if (outcome === null) return ["Confirmation: not attempted."];
  if (outcome.result === null) return [`Confirmation: ${who(outcome)} failed: ${inline(outcome.error)}`];
  return [
    `Confirmation: ${who(outcome)} ${verdict(outcome.result)}.`,
    "",
    ...quote(outcome.result.observed),
    "",
    "Confirmation evidence:",
    "",
    ...paths(outcome.result.evidence),
    ...images(outcome.result.evidence, root),
  ];
}

function reported(first: Finding, fact: string, browser: string | null) {
  const lines = [
    `### ${inline(first.title)}`,
    "",
    `- Kind: ${first.kind}`,
    fact,
    "- Conditions:",
    `  - Account: ${inline(first.conditions.account)}`,
    `  - Data: ${inline(first.conditions.data)}`,
    `  - Viewport: ${inline(first.conditions.viewport)}`,
    `  - Browser: ${inline(first.conditions.browser)}`,
    ...(browser === null ? [] : [`  - Browser version: ${inline(browser)}`]),
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
  return lines;
}

export function lead(group: Group) {
  const [first] = group.findings;
  if (first === undefined) throw new Error(`Group ${group.id} has no findings`);
  return first;
}

function section(group: Group, interns: string[], browser: string | null, root: string) {
  const first = lead(group);
  const others = group.findings.slice(1);
  const lines = reported(first, `- Reproductions: ${interns.length} (${interns.join(", ")})`, browser);
  lines.push("Evidence:", "", ...paths(first.evidence), ...images(first.evidence, root), "");
  if (others.length > 0) {
    lines.push("Other reports:", "");
    for (const finding of others) lines.push(`- ${inline(finding.id)}`, ...quote(finding.observed, "  "));
    lines.push("");
  }
  lines.push(...confirmation(group, root), "");
  return lines;
}

function ticket(state: RunState, browserVersion: string | null, group: Group, interns: string[]): Ticket {
  const first = lead(group);
  const others = group.findings.slice(1);
  const { account, data, viewport, browser, network } = first.conditions;
  const lines = [
    `- Run: ${state.runId}`,
    `- Commit: ${commit(state.target)}`,
    `- Kind: ${first.kind}`,
    `- Reproductions: ${interns.length} (${interns.join(", ")})`,
    "",
    "## Conditions",
    "",
    ...block(
      [`Account: ${account}`, `Data: ${data}`, `Viewport: ${viewport}`, `Browser: ${browser}`, ...(browserVersion === null ? [] : [`Browser version: ${browserVersion}`]), `Network: ${network}`].join("\n"),
    ),
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
  lines.push("## Evidence", "", ...files(first.evidence), ...images(first.evidence, ""), "");
  if (others.length > 0) {
    lines.push("## Other reports", "");
    for (const finding of others) lines.push(`${finding.intern}:`, "", ...block(finding.observed), "");
  }
  lines.push("## Confirmation", "");
  const outcome = group.confirmation;
  if (outcome === null) lines.push("Not attempted.", "");
  else if (outcome.result === null) lines.push(`${who(outcome)} failed:`, "", ...block(outcome.error), "");
  else {
    lines.push(`${who(outcome)} ${verdict(outcome.result)}.`, "", ...block(outcome.result.observed), "");
    lines.push("Confirmation evidence:", "", ...files(outcome.result.evidence), ...images(outcome.result.evidence, ""), "");
  }
  const evidence = [...new Set([...first.evidence, ...(outcome?.result?.evidence ?? [])])];
  return { id: group.id, title: first.title, body: lines.join("\n"), evidence };
}

export async function writeTickets(runDir: string, tickets: Ticket[]): Promise<void> {
  for (const draft of tickets) {
    const dir = join(runDir, "tickets", draft.id);
    const missing: string[] = [];
    for (const entry of draft.evidence) {
      const reason = await linkEvidence(runDir, entry, join(dir, entry));
      if (reason !== null) missing.push(`${entry}: ${reason}`);
    }
    const body = missing.length === 0 ? draft.body : [draft.body, "## Evidence not in this folder", "", ...block(missing.join("\n")), ""].join("\n");
    await Bun.write(join(dir, "title.txt"), `${draft.title}\n`);
    await Bun.write(join(dir, "body.md"), body);
  }
}

function role(state: RunState, name: InternState["role"]) {
  return state.interns.filter((intern) => intern.role === name).length;
}

function providersOf(state: RunState) {
  return [...new Set(state.interns.flatMap((intern) => (intern.provider === null ? [] : [intern.provider])))];
}

function commit(target: RunState["target"]) {
  return `\`${target.commit}\`${target.dirty ? ", with the uncommitted changes and untracked files of the working tree" : ""}`;
}

function ran(state: RunState, browser: string | null) {
  return [
    `- Target: \`${state.target.repo}\`, path \`${state.target.path || "."}\``,
    `- Commit: ${commit(state.target)}`,
    `- Browser: ${browser === null ? "not read" : inline(browser)}`,
    `- Ran: ${state.startedAt}${state.endedAt === null ? "" : ` to ${state.endedAt}`}`,
  ];
}

function internTable(state: RunState) {
  const lines = ["## Interns", ""];
  if (state.interns.length === 0) return [...lines, "No intern ran."];
  lines.push("| Id | Role | Provider | Model | Status | Findings | Detail |", "| --- | --- | --- | --- | --- | --- | --- |");
  for (const intern of state.interns) {
    lines.push(`| ${[intern.id, intern.role, intern.provider, intern.model, intern.status, intern.findings, intern.detail].map(cell).join(" | ")} |`);
  }
  return lines;
}

function egressTable(connections: EgressRow[]) {
  const lines = ["## Egress connections", ""];
  if (connections.length === 0) return [...lines, "No connection went through a relay."];
  lines.push("| Host | Outcome | Error | Connections | Interns |", "| --- | --- | --- | --- | --- |");
  for (const row of connections) {
    lines.push(`| ${[row.host, row.outcome ?? "no connection", row.error, row.connections, row.interns.join(", ")].map(cell).join(" | ")} |`);
  }
  return lines;
}

function usage(environment: EnvironmentStats) {
  const ready = environment.readyAt === null ? "not reached" : `after ${((Date.parse(environment.readyAt) - Date.parse(environment.startedAt)) / 1000).toFixed(1)} s`;
  const lines = [`### ${environment.intern}, attempt ${environment.attempt}`, "", `- Started: ${environment.startedAt}`, `- Ready: ${ready}`, ""];
  if (environment.containers === null) return [...lines, "No container was read before teardown."];
  lines.push("| Container | State | Peak memory | Out-of-memory kill | Restarts |", "| --- | --- | --- | --- | --- |");
  for (const container of environment.containers) {
    const peak = container.memoryPeak === null ? "not read" : `${(container.memoryPeak / 1024 ** 2).toFixed(1)} MiB`;
    lines.push(`| ${[`${container.service}-${container.number}`, container.state, peak, container.oomKilled ? "yes" : "no", container.restarts].map(cell).join(" | ")} |`);
  }
  return lines;
}

function environmentSection(environments: EnvironmentStats[]) {
  const lines = ["## Environments"];
  if (environments.length === 0) return [...lines, "", "No environment started."];
  for (const environment of environments) lines.push("", ...usage(environment));
  return lines;
}

export function renderReport(
  runDir: string,
  state: RunState,
  browser: string | null,
  groups: Group[],
  rejected: Rejected[],
  egress: Egress,
  environments: EnvironmentStats[],
): { markdown: string; json: unknown; tickets: Ticket[] } {
  const root = resolve(runDir);
  const rows = groups.map((group) => ({ group, interns: reproductions(group) }));
  const connections = egressRows(egress);
  const confirmed = rows.filter((row) => row.interns.length >= 2 && !wrongSteps(row.group));
  const notConfirmed = rows.filter((row) => !confirmed.includes(row));
  const summary = {
    runId: state.runId,
    target: state.target,
    browser,
    phase: state.phase,
    error: state.error,
    startedAt: state.startedAt,
    endedAt: state.endedAt,
    interns: { testing: role(state, "intern"), confirming: role(state, "confirm"), judging: role(state, "judge") },
    providers: providersOf(state),
    confirmedGroups: confirmed.length,
    notConfirmedGroups: notConfirmed.length,
    rejectedFiles: rejected.length,
  };

  const lines = [
    `# QA Interns run ${state.runId}`,
    "",
    ...ran(state, browser),
    `- Interns: ${summary.interns.testing} testing, ${summary.interns.confirming} confirming, ${summary.interns.judging} judging`,
    `- Providers: ${summary.providers.length > 0 ? summary.providers.join(", ") : "none"}`,
    `- Confirmed groups: ${summary.confirmedGroups}`,
    `- Groups not confirmed: ${summary.notConfirmedGroups}`,
    `- Rejected finding files: ${summary.rejectedFiles}`,
  ];
  if (state.error !== null) lines.push(`- Error: ${inline(state.error)}`);
  lines.push("", "## Confirmed", "");
  if (confirmed.length === 0) lines.push("No finding was confirmed.", "");
  for (const row of confirmed) lines.push(...section(row.group, row.interns, browser, root));
  lines.push("## Not confirmed", "");
  if (notConfirmed.length === 0) lines.push("Every finding was confirmed.", "");
  for (const row of notConfirmed) lines.push(...section(row.group, row.interns, browser, root));
  lines.push("## Rejected finding files", "");
  if (rejected.length === 0) lines.push("No finding file was rejected.");
  for (const entry of rejected) lines.push(`- ${inline(entry.file)}: ${inline(entry.reason)}`);
  lines.push("", ...internTable(state), "", ...egressTable(connections), "", ...environmentSection(environments));

  return {
    markdown: stripControl(`${lines.join("\n")}\n`),
    json: {
      run: summary,
      groups: [...confirmed, ...notConfirmed].map((row) => ({
        id: row.group.id,
        confirmed: confirmed.includes(row),
        reproductions: row.interns,
        findings: row.group.findings,
        confirmation: row.group.confirmation,
      })),
      rejected,
      interns: state.interns,
      egress: connections,
      environments,
    },
    tickets: confirmed.map((row) => ticket(state, browser, row.group, row.interns)),
  };
}

function outcome(group: Group) {
  const result = group.confirmation?.result ?? null;
  return result === null ? null : confirms(result);
}

export function renderReplay(runDir: string, state: RunState, browser: string | null, replay: Replay, egress: Egress, environments: EnvironmentStats[]): { markdown: string; json: unknown } {
  const root = resolve(runDir);
  const connections = egressRows(egress);
  const reproduced = replay.groups.filter((group) => outcome(group) === true);
  const notReproduced = replay.groups.filter((group) => outcome(group) === false);
  const unchecked = replay.groups.filter((group) => outcome(group) === null);
  const summary = {
    runId: state.runId,
    replay: { runId: replay.runId, commit: replay.target.commit, dirty: replay.target.dirty },
    target: state.target,
    browser,
    phase: state.phase,
    error: state.error,
    startedAt: state.startedAt,
    endedAt: state.endedAt,
    interns: { confirming: role(state, "confirm") },
    providers: providersOf(state),
    reproducedGroups: reproduced.length,
    notReproducedGroups: notReproduced.length,
    uncheckedGroups: unchecked.length,
  };

  const lines = [
    `# QA Interns run ${state.runId}`,
    "",
    `- Replay of: run \`${replay.runId}\` at commit ${commit(replay.target)}`,
    ...ran(state, browser),
    `- Interns: ${summary.interns.confirming} confirming`,
    `- Providers: ${summary.providers.length > 0 ? summary.providers.join(", ") : "none"}`,
    `- Groups reproduced: ${summary.reproducedGroups}`,
    `- Groups not reproduced: ${summary.notReproducedGroups}`,
    `- Groups not checked: ${summary.uncheckedGroups}`,
  ];
  if (state.error !== null) lines.push(`- Error: ${inline(state.error)}`);
  lines.push("");
  const sections = [
    ["Reproduced", "No group was reproduced.", reproduced],
    ["Not reproduced", "No intern reported a group as not reproduced.", notReproduced],
    ["Not checked", "Every group was checked.", unchecked],
  ] as const;
  for (const [heading, none, list] of sections) {
    lines.push(`## ${heading}`, "");
    if (list.length === 0) lines.push(none, "");
    for (const group of list) lines.push(...reported(lead(group), `- Group: ${inline(group.id)} in run ${inline(replay.runId)}`, null), ...confirmation(group, root), "");
  }
  lines.push(...internTable(state), "", ...egressTable(connections), "", ...environmentSection(environments));

  return {
    markdown: stripControl(`${lines.join("\n")}\n`),
    json: {
      run: summary,
      groups: [...reproduced, ...notReproduced, ...unchecked].map((group) => ({
        id: group.id,
        reproduced: outcome(group),
        finding: lead(group),
        confirmation: group.confirmation,
      })),
      interns: state.interns,
      egress: connections,
      environments,
    },
  };
}

export const storedRunSchema = z.object({ run: z.object({ replay: z.object({ runId: z.string() }).optional() }) });

export const storedFindingSchema = z.object({
  id: z.string(),
  intern: z.string(),
  title: z.string(),
  kind: z.enum(kinds),
  conditions: z.object({ account: z.string(), data: z.string(), viewport: z.string(), browser: z.string(), network: z.string() }),
  steps: z.array(z.string()).min(1),
  observed: z.string(),
  contradicts: z.string().nullable(),
  evidence: z.array(z.string()),
  environment: z.object({
    commit: z.string(),
    dirty: z.boolean(),
    environment: z.string(),
    provider: z.enum(providerNames),
    model: z.string().nullable(),
  }),
});

const storedGroupsSchema = z.object({
  groups: z.array(z.object({ id: z.string().min(1), confirmed: z.boolean(), findings: z.array(storedFindingSchema).min(1) })),
});

export function replayLock(runDir: string): string {
  return join(runDir, "replay.lock");
}

export async function readReplay(runDir: string, only: string[]): Promise<Replay> {
  const state = await readState(runDir);
  const file = join(runDir, "findings.json");
  const absent = `Run ${state.runId} has no findings.json yet. Its phase is ${state.phase}.`;
  const { run } = await readJson(file, storedRunSchema, absent);
  if (run.replay !== undefined) throw new Error(`Run ${state.runId} is a replay of run ${run.replay.runId}. Replay run ${run.replay.runId} instead.`);
  const { groups } = await readJson(file, storedGroupsSchema, absent);
  const confirmed = groups.filter((group) => group.confirmed);
  const ids = confirmed.map((group) => group.id);
  const missing = only.filter((id) => !ids.includes(id));
  if (missing.length > 0) {
    throw new Error(`Run ${state.runId} has no confirmed group ${missing.join(", ")}. Its confirmed groups are ${ids.length > 0 ? ids.join(", ") : "none"}.`);
  }
  const chosen = only.length === 0 ? confirmed : confirmed.filter((group) => only.includes(group.id));
  if (chosen.length === 0) throw new Error(`Run ${state.runId} has no confirmed group to replay.`);
  return { runId: state.runId, target: state.target, groups: chosen.map((group) => ({ id: group.id, findings: group.findings, confirmation: null })) };
}
