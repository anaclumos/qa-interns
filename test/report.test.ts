import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readReplay, renderReplay, renderReport, reproductions, type Egress } from "../src/report.ts";
import { writeState } from "../src/state.ts";
import type { EnvironmentStats, Finding, Group, InternState, Provider, RelayRecord, RunState } from "../src/types.ts";

function intern(id: string, role: InternState["role"], provider: Provider | null, status: InternState["status"], findings: number, detail: string | null): InternState {
  return {
    id,
    role,
    charter: role === "intern" ? "Heavy user: many records, pagination, sorting, filtering, search, bulk actions." : "",
    group: role === "confirm" ? "g1" : null,
    provider,
    login: provider === null ? null : `${provider}-1`,
    model: provider === "claude" ? "claude-opus-5-5" : provider === "codex" ? "gpt-5.5" : null,
    project: `qa-7c1e9a04-${id}`,
    status,
    detail,
    findings,
    rejected: 0,
    startedAt: "2026-09-26T09:00:05.000Z",
    endedAt: "2026-09-26T09:31:10.000Z",
  };
}

const state: RunState = {
  runId: "7c1e9a04",
  pid: 48213,
  pidStart: 8312765,
  target: { repo: "/home/owner/src/qa-interns", path: "eval/ledger", commit: "3f9c2e1d8a7b6c5d4e3f2a1b0c9d8e7f6a5b4c3d", dirty: false },
  options: { interns: 3, minutes: 30, confirmMinutes: 10, concurrency: 3 },
  phase: "done",
  error: null,
  startedAt: "2026-09-26T09:00:00.000Z",
  updatedAt: "2026-09-26T09:52:00.000Z",
  endedAt: "2026-09-26T09:52:00.000Z",
  interns: [
    intern("i1", "intern", "claude", "done", 1, null),
    intern("i2", "intern", "codex", "done", 1, "stopped at minute 21: \"I found | nothing else\""),
    intern("i3", "intern", "claude", "done", 2, null),
    intern("judge", "judge", "codex", "done", 0, null),
    intern("c1", "confirm", "codex", "done", 0, null),
    intern("c2", "confirm", "codex", "done", 0, null),
    intern("c3", "confirm", null, "limited", 0, "no login with spare capacity"),
  ],
};

function finding(id: string, title: string, observed: string, contradicts: string | null = null): Finding {
  const internId = id.slice(0, id.indexOf("/"));
  return {
    id,
    intern: internId,
    title,
    kind: contradicts === null ? "wrong-data" : "inconsistency",
    conditions: { account: "owner@acme.test, role owner", data: "freshly seeded", viewport: "1280x720", browser: "one tab, signed in", network: "online" },
    steps: ["Sign in as owner@acme.test with the password acme-owner-pass.", "Open http://web:3000/invoices.", "Open http://web:3000/invoices?page=2."],
    observed,
    contradicts,
    evidence: [`interns/${internId}/out/evidence/${id.slice(id.indexOf("/") + 1)}.png`],
    environment: { commit: state.target.commit, dirty: state.target.dirty, environment: `qa-7c1e9a04-${internId}`, provider: internId === "i2" ? "codex" : "claude", model: null },
  };
}

const overlap: Group = {
  id: "g1",
  findings: [
    finding("i1/pagination-overlap", "Invoice INV-0014 appears on page 1 and page 2", "Page 2 starts with \"INV-0014 Stark Industries\"."),
    finding("i2/page-two-repeats", "Page 2 repeats the last invoice of page 1", "The first row of page 2 is INV-0014.\nIt is also the last row of page 1."),
  ],
  confirmation: { intern: "c1", provider: "codex", result: { reproduced: true, observed: "Page 2 starts with INV-0014.", evidence: ["interns/c1/out/evidence/repeat.png"] }, error: null },
};

const exportTotal: Group = {
  id: "g2",
  findings: [finding("i3/export-total", "CSV export total for INV-0002 leaves out tax", "The CSV row for INV-0002 has the total 5246.00.", "The detail page at /invoices/2 shows €5,770.60.")],
  confirmation: { intern: "c2", provider: "codex", result: { reproduced: false, observed: "The CSV row for INV-0002 has the total 5770.60.", evidence: [] }, error: null },
};

const negative: Group = {
  id: "g3",
  findings: [finding("i3/negative-quantity", "An invoice with quantity -3 saves with a negative total", "The detail page shows \"Total -$75.00\".")],
  confirmation: { intern: "c3", provider: null, result: null, error: "no login with spare capacity" },
};

const rejected = [{ intern: "i2", file: "interns/i2/out/findings/slow-export.json", reason: "steps must have at least one entry" }];

const environments: EnvironmentStats[] = [
  {
    intern: "i1",
    attempt: 1,
    startedAt: "2026-09-26T09:00:05.000Z",
    readyAt: "2026-09-26T09:00:47.300Z",
    containers: [
      { service: "db", number: 1, state: "running", oomKilled: false, restarts: 0, memoryPeak: 83_886_080 },
      { service: "qa-runner", number: 1, state: "running", oomKilled: false, restarts: 0, memoryPeak: 1_288_490_189 },
      { service: "web|api", number: 2, state: "exited", oomKilled: true, restarts: 3, memoryPeak: null },
    ],
  },
  { intern: "i2", attempt: 2, startedAt: "2026-09-26T09:03:00.000Z", readyAt: null, containers: null },
];

function record(n: number, host: string | null, outcome: RelayRecord["outcome"], error: string | null = null): RelayRecord {
  return { n, host, outcome, error };
}

const egress: Egress = {
  hosts: ["api.pwnedpasswords.com", "ai-gateway.vercel.sh"],
  relays: [
    { intern: "i1", records: [record(1, "api.pwnedpasswords.com", "connected"), record(2, "api.pwnedpasswords.com", "failed", "ENOTFOUND"), record(3, "api.pwnedpasswords.com", "connected")] },
    { intern: "i2", records: [record(40001, "api.pwnedpasswords.com", "connected"), record(40002, null, "denied")] },
    { intern: "i2", records: [record(1, null, "incomplete", "timeout")] },
    { intern: "judge", records: [] },
    { intern: "c1", records: [record(1, "x|y.example", "denied"), record(2, "api.pwnedpasswords.com", "connected")] },
  ],
};

const none: Egress = { hosts: [], relays: [] };

describe("reproductions", () => {
  test("counts distinct reporters plus the confirming intern only when it reproduced", () => {
    expect(reproductions(overlap)).toEqual(["i1", "i2", "c1"]);
    expect(reproductions(exportTotal)).toEqual(["i3"]);
    expect(reproductions(negative)).toEqual(["i3"]);
    expect(reproductions({ ...overlap, findings: [overlap.findings[0]!, { ...overlap.findings[0]!, id: "i1/again" }], confirmation: null })).toEqual(["i1"]);
  });
});

describe("renderReport", () => {
  const { markdown, json } = renderReport(state, [exportTotal, overlap, negative], rejected, egress, environments);

  test("orders the sections: confirmed, seen once, rejected files, interns, egress connections, environments", () => {
    const headings = markdown.split("\n").filter((line) => line.startsWith("## "));
    expect(headings).toEqual(["## Confirmed", "## Seen once", "## Rejected finding files", "## Interns", "## Egress connections", "## Environments"]);
    const at = (text: string) => markdown.indexOf(text);
    expect(at("## Confirmed")).toBeLessThan(at(`### ${overlap.findings[0]!.title}`));
    expect(at(`### ${overlap.findings[0]!.title}`)).toBeLessThan(at("## Seen once"));
    expect(at("## Seen once")).toBeLessThan(at(`### ${exportTotal.findings[0]!.title}`));
    expect(at("## Seen once")).toBeLessThan(at(`### ${negative.findings[0]!.title}`));
    expect(at(`### ${negative.findings[0]!.title}`)).toBeLessThan(at("## Rejected finding files"));
    expect(at("## Rejected finding files")).toBeLessThan(at(rejected[0]!.file));
    expect(at(rejected[0]!.file)).toBeLessThan(at("## Interns"));
    expect(at("## Interns")).toBeLessThan(at("## Egress connections"));
  });

  test("the egress table counts connections per host, outcome, and error, lists each egress host without connections, and counts records the relay log dropped", () => {
    expect((json as { egress: unknown }).egress).toEqual([
      { host: "api.pwnedpasswords.com", outcome: "connected", error: null, connections: 4, interns: ["i1", "i2", "c1"] },
      { host: "api.pwnedpasswords.com", outcome: "failed", error: "ENOTFOUND", connections: 1, interns: ["i1"] },
      { host: "ai-gateway.vercel.sh", outcome: null, error: null, connections: 0, interns: [] },
      { host: "x|y.example", outcome: "denied", error: null, connections: 1, interns: ["c1"] },
      { host: null, outcome: "unrecorded", error: null, connections: 40000, interns: ["i2"] },
      { host: null, outcome: "denied", error: null, connections: 1, interns: ["i2"] },
      { host: null, outcome: "incomplete", error: "timeout", connections: 1, interns: ["i2"] },
    ]);
    const rows = markdown.slice(markdown.indexOf("## Egress connections"), markdown.indexOf("## Environments")).split("\n").filter((line) => line.startsWith("| "));
    expect(rows).toEqual([
      "| Host | Outcome | Error | Connections | Interns |",
      "| --- | --- | --- | --- | --- |",
      "| api.pwnedpasswords.com | connected |  | 4 | i1, i2, c1 |",
      "| api.pwnedpasswords.com | failed | ENOTFOUND | 1 | i1 |",
      "| ai-gateway.vercel.sh | no connection |  | 0 |  |",
      "| x\\|y.example | denied |  | 1 | c1 |",
      "|  | unrecorded |  | 40000 | i2 |",
      "|  | denied |  | 1 | i2 |",
      "|  | incomplete | timeout | 1 | i2 |",
    ]);
  });

  test("the header names the commit, and the uncommitted changes when the run copied the working tree", () => {
    expect(markdown.split("\n")).toContain(`- Commit: \`${state.target.commit}\``);
    const dirty = renderReport({ ...state, target: { ...state.target, dirty: true } }, [], [], none, []).markdown;
    expect(dirty.split("\n")).toContain(`- Commit: \`${state.target.commit}\`, with the uncommitted changes and untracked files of the working tree`);
  });

  test("a confirmed group lists its reproduction count and interns", () => {
    const confirmed = markdown.slice(markdown.indexOf("## Confirmed"), markdown.indexOf("## Seen once"));
    expect(confirmed).toContain("3 (i1, i2, c1)");
    expect(confirmed).toContain("i2/page-two-repeats");
    expect(confirmed).toContain("> It is also the last row of page 1.");
    expect(confirmed).toContain("interns/i1/out/evidence/pagination-overlap.png");
    expect(confirmed).toContain("1. Sign in as owner@acme.test with the password acme-owner-pass.");
  });

  test("the intern table has one row per intern and escapes pipes in cells", () => {
    const rows = markdown.slice(markdown.indexOf("## Interns"), markdown.indexOf("## Egress connections")).split("\n").filter((line) => line.startsWith("| "));
    expect(rows).toHaveLength(state.interns.length + 2);
    for (const intern of state.interns) expect(rows.filter((row) => row.startsWith(`| ${intern.id} |`))).toHaveLength(1);
    expect(rows.find((row) => row.startsWith("| i2 |"))).toContain("I found \\| nothing else");
  });

  test("each environment lists its time to ready and one row per container with its peak memory, out-of-memory kill, and restarts", () => {
    const section = markdown.slice(markdown.indexOf("## Environments"));
    const first = section.slice(section.indexOf("### i1, attempt 1"), section.indexOf("### i2, attempt 2"));
    expect(first).toContain("- Started: 2026-09-26T09:00:05.000Z\n- Ready: after 42.3 s\n");
    expect(first.split("\n").filter((line) => line.startsWith("| ")).slice(2)).toEqual([
      "| db-1 | running | 80.0 MiB | no | 0 |",
      "| qa-runner-1 | running | 1228.8 MiB | no | 0 |",
      "| web\\|api-2 | exited | not read | yes | 3 |",
    ]);
    const second = section.slice(section.indexOf("### i2, attempt 2"));
    expect(second).toContain("- Ready: not reached\n");
    expect(second).toContain("No container was read before teardown.");
    expect(second).not.toContain("| ");
  });

  test("the JSON form carries the same groups, rejected files, interns, and environments", () => {
    const data = json as { run: { confirmedGroups: number; seenOnceGroups: number; rejectedFiles: number; providers: string[] }; groups: { id: string; confirmed: boolean; reproductions: string[] }[]; rejected: unknown; interns: unknown; environments: unknown };
    expect(data.run).toMatchObject({ confirmedGroups: 1, seenOnceGroups: 2, rejectedFiles: 1, providers: ["claude", "codex"] });
    expect(data.groups.map((group) => [group.id, group.confirmed, group.reproductions])).toEqual([
      ["g1", true, ["i1", "i2", "c1"]],
      ["g2", false, ["i3"]],
      ["g3", false, ["i3"]],
    ]);
    expect(data.rejected).toEqual(rejected);
    expect(data.interns).toEqual(state.interns);
    expect(data.environments).toEqual(environments);
    expect(JSON.parse(JSON.stringify(json))).toEqual(json);
  });

  test("strips control characters from agent text and file names and keeps the sections", () => {
    const noisy: Group = {
      id: "g1",
      findings: [{ ...finding("i1/bidi", "Totals \u{202e}disagree", "Row \u001b[31mred\u001b[0m"), evidence: ["interns/i1/out/evidence/a\u0007.png"] }],
      confirmation: { intern: "c1", provider: "codex", result: null, error: "adapter said \u009bno" },
    };
    const relays = [{ intern: "i1", records: [record(1, "a\u001b[31m\u{202e}.example", "denied")] }];
    const text = renderReport(state, [noisy], [{ intern: "i2", file: "interns/i2/out/findings/x\u{2066}y.json", reason: "bad\u0000 input" }], { hosts: [], relays }, []).markdown;
    for (const char of ["\u{202e}", "\u001b", "\u0007", "\u009b", "\u{2066}", "\u0000"]) expect(text.includes(char)).toBe(false);
    expect(text).toContain("### Totals disagree\n");
    expect(text).toContain("> Row \\[31mred\\[0m\n");
    expect(text).toContain("- interns/i1/out/evidence/a.png\n");
    expect(text).toContain("Confirmation: c1 (codex) failed: adapter said no\n");
    expect(text).toContain("- interns/i2/out/findings/xy.json: bad input\n");
    expect(text).toContain("| a\\[31m.example | denied |  | 1 | i1 |\n");
    expect(text.split("\n").filter((line) => line.startsWith("## "))).toEqual(["## Confirmed", "## Seen once", "## Rejected finding files", "## Interns", "## Egress connections", "## Environments"]);
  });

  test("agent text cannot add a heading or inline HTML", () => {
    const base = finding("i1/forged", "Totals disagree", "Row <script>alert(1)</script>\n## Interns");
    const forged: Group = { id: "g1", findings: [{ ...base, conditions: { ...base.conditions, account: "x\n\n## Interns" } }], confirmation: null };
    const text = renderReport(state, [forged], [], none, []).markdown;
    expect(text.split("\n").filter((line) => line.trimStart().startsWith("## Interns"))).toEqual(["## Interns"]);
    expect(text).not.toContain("<script>");
    expect(text).toContain("  - Account: x  \\#\\# Interns\n");
    expect(text).toContain("> Row &lt;script&gt;alert(1)&lt;/script&gt;\n> \\#\\# Interns\n");
  });

  test("agent text cannot add links or images", () => {
    const linked = finding("i1/linked", "See ![x](http://attacker.test/p.png)", "Click [here](http://attacker.test)");
    const text = renderReport(state, [{ id: "g1", findings: [linked], confirmation: null }], [], none, []).markdown;
    expect(text).toContain("### See \\!\\[x\\](http://attacker.test/p.png)\n");
    expect(text).toContain("> Click \\[here\\](http://attacker.test)\n");
  });

  test("a run with nothing to report still has a line in every section", () => {
    const empty = renderReport({ ...state, interns: [] }, [], [], none, []).markdown;
    const lines = empty.split("\n");
    const headings = ["## Confirmed", "## Seen once", "## Rejected finding files", "## Interns", "## Egress connections", "## Environments"];
    for (const heading of headings) {
      const start = lines.indexOf(heading);
      const next = lines.findIndex((line, index) => index > start && line.startsWith("## "));
      const body = lines.slice(start + 1, next === -1 ? undefined : next).filter((line) => line.trim() !== "");
      expect(body).toHaveLength(1);
      expect(body[0]?.startsWith("#")).toBe(false);
    }
  });
});

describe("renderReplay", () => {
  const replayState: RunState = {
    ...state,
    runId: "9b4d2f61",
    target: { ...state.target, commit: "a0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9" },
    options: { interns: 0, minutes: 0, confirmMinutes: 10, concurrency: 3 },
    interns: state.interns.filter((entry) => entry.role === "confirm"),
  };
  const replay = { runId: state.runId, target: state.target, groups: [exportTotal, overlap, negative] };
  const replayEgress: Egress = { hosts: ["api.pwnedpasswords.com"], relays: [{ intern: "c1", records: [record(1, "api.pwnedpasswords.com", "failed", "ECONNREFUSED")] }] };
  const replayEnvironments = [{ ...environments[0]!, intern: "c1" }];
  const { markdown, json } = renderReplay(replayState, replay, replayEgress, replayEnvironments);
  const between = (text: string, start: string, end: string) => text.slice(text.indexOf(start), text.indexOf(end));

  test("sorts the groups into reproduced, not reproduced, and not checked, under the ids of the earlier run", () => {
    expect(markdown.split("\n").filter((line) => line.startsWith("## "))).toEqual(["## Reproduced", "## Not reproduced", "## Not checked", "## Interns", "## Egress connections", "## Environments"]);
    expect(markdown.slice(markdown.indexOf("## Environments"))).toContain("### c1, attempt 1\n\n- Started: 2026-09-26T09:00:05.000Z\n- Ready: after 42.3 s\n");
    expect(markdown).toContain(`- Replay of: run \`7c1e9a04\` at commit \`${state.target.commit}\`\n`);
    expect(markdown).toContain(`- Commit: \`${replayState.target.commit}\`\n`);
    expect(markdown).toContain("- Groups reproduced: 1\n- Groups not reproduced: 1\n- Groups not checked: 1\n");
    const reproduced = between(markdown, "## Reproduced", "## Not reproduced");
    expect(reproduced).toContain(`### ${overlap.findings[0]!.title}`);
    expect(reproduced).toContain("- Group: g1 in run 7c1e9a04\n");
    expect(reproduced).toContain("1. Sign in as owner@acme.test with the password acme-owner-pass.");
    expect(reproduced).toContain("Confirmation: c1 (codex) reproduced it.");
    expect(reproduced).not.toContain("i2/page-two-repeats");
    expect(reproduced).not.toContain("interns/i1/out/evidence/pagination-overlap.png");
    const notReproduced = between(markdown, "## Not reproduced", "## Not checked");
    expect(notReproduced).toContain(`### ${exportTotal.findings[0]!.title}`);
    expect(notReproduced).toContain("> The detail page at /invoices/2 shows €5,770.60.");
    expect(notReproduced).toContain("Confirmation: c2 (codex) did not reproduce it.");
    const unchecked = between(markdown, "## Not checked", "## Interns");
    expect(unchecked).toContain(`### ${negative.findings[0]!.title}`);
    expect(unchecked).toContain("Confirmation: c3 failed: no login with spare capacity");
  });

  test("the JSON form names the earlier run and carries each group's result, the finding the intern followed, its confirmation, and the environments", () => {
    const data = json as { run: unknown; groups: { id: string; reproduced: boolean | null; finding: { id: string }; confirmation: unknown }[]; interns: unknown; environments: unknown };
    expect(data.run).toMatchObject({
      runId: "9b4d2f61",
      replay: { runId: "7c1e9a04", commit: state.target.commit },
      target: replayState.target,
      interns: { confirming: 3 },
      providers: ["codex"],
      reproducedGroups: 1,
      notReproducedGroups: 1,
      uncheckedGroups: 1,
    });
    expect(data.groups.map((group) => [group.id, group.reproduced, group.finding.id])).toEqual([
      ["g1", true, "i1/pagination-overlap"],
      ["g2", false, "i3/export-total"],
      ["g3", null, "i3/negative-quantity"],
    ]);
    expect(data.groups[0]!.confirmation).toEqual(overlap.confirmation);
    expect(data.interns).toEqual(replayState.interns);
    expect(data.environments).toEqual(replayEnvironments);
    expect(JSON.parse(JSON.stringify(json))).toEqual(json);
  });

  test("counts the connections of the replay's environments per egress host and outcome", () => {
    expect((json as { egress: unknown }).egress).toEqual([{ host: "api.pwnedpasswords.com", outcome: "failed", error: "ECONNREFUSED", connections: 1, interns: ["c1"] }]);
    expect(markdown.slice(markdown.indexOf("## Egress connections"))).toContain("| api.pwnedpasswords.com | failed | ECONNREFUSED | 1 | c1 |\n");
  });

  describe("readReplay", () => {
    const dirs: string[] = [];
    afterAll(async () => {
      for (const dir of dirs) await rm(dir, { recursive: true });
    });

    async function runDir(run: RunState, report: unknown): Promise<string> {
      const dir = await mkdtemp(join(tmpdir(), "qa-interns-replay-"));
      dirs.push(dir);
      await writeState(dir, run);
      await Bun.write(join(dir, "findings.json"), `${JSON.stringify(report, null, 2)}\n`);
      return dir;
    }

    test("reads the confirmed groups of a run's findings.json, or the ones named, without their confirmations", async () => {
      const dir = await runDir(state, renderReport(state, [exportTotal, overlap, negative], rejected, egress, environments).json);
      expect(await readReplay(dir, [])).toEqual({ runId: state.runId, target: state.target, groups: [{ ...overlap, confirmation: null }] });
      expect((await readReplay(dir, ["g1", "g1"])).groups.map((group) => group.id)).toEqual(["g1"]);
      await expect(readReplay(dir, ["g1", "g2"])).rejects.toThrow("Run 7c1e9a04 has no confirmed group g2. Its confirmed groups are g1.");
    });

    test("rejects a replay and a run without a confirmed group", async () => {
      await expect(readReplay(await runDir(replayState, json), [])).rejects.toThrow("Run 9b4d2f61 is a replay of run 7c1e9a04. Replay run 7c1e9a04 instead.");
      const unconfirmed = await runDir(state, renderReport(state, [exportTotal], [], none, []).json);
      await expect(readReplay(unconfirmed, [])).rejects.toThrow("Run 7c1e9a04 has no confirmed group to replay.");
      await expect(readReplay(unconfirmed, ["g1"])).rejects.toThrow("Run 7c1e9a04 has no confirmed group g1. Its confirmed groups are none.");
    });
  });

  test("names the uncommitted changes of an earlier run that copied the working tree", () => {
    const dirty = renderReplay(replayState, { ...replay, target: { ...state.target, dirty: true } }, none, []);
    expect(dirty.markdown).toContain(`- Replay of: run \`7c1e9a04\` at commit \`${state.target.commit}\`, with the uncommitted changes and untracked files of the working tree\n`);
    expect((dirty.json as { run: unknown }).run).toMatchObject({ replay: { runId: "7c1e9a04", commit: state.target.commit, dirty: true } });
  });

  test("a group without a confirmation is not checked", () => {
    const text = renderReplay(replayState, { ...replay, groups: [{ ...overlap, confirmation: null }] }, none, []).markdown;
    expect(between(text, "## Reproduced", "## Not reproduced")).toContain("No group was reproduced.");
    expect(between(text, "## Not reproduced", "## Not checked")).toContain("No intern reported a group as not reproduced.");
    expect(between(text, "## Not checked", "## Interns")).toContain("Confirmation: not attempted.");
  });
});
