import { describe, expect, test } from "bun:test";
import { renderReport, reproductions } from "../src/report.ts";
import type { Finding, Group, InternState, Provider, RunState } from "../src/types.ts";

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
  target: { repo: "/home/owner/src/qa-interns", path: "eval/ledger", commit: "3f9c2e1d8a7b6c5d4e3f2a1b0c9d8e7f6a5b4c3d" },
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
    environment: { commit: state.target.commit, environment: `qa-7c1e9a04-${internId}`, provider: internId === "i2" ? "codex" : "claude", model: null },
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

describe("reproductions", () => {
  test("counts distinct reporters plus the confirming intern only when it reproduced", () => {
    expect(reproductions(overlap)).toEqual(["i1", "i2", "c1"]);
    expect(reproductions(exportTotal)).toEqual(["i3"]);
    expect(reproductions(negative)).toEqual(["i3"]);
    expect(reproductions({ ...overlap, findings: [overlap.findings[0]!, { ...overlap.findings[0]!, id: "i1/again" }], confirmation: null })).toEqual(["i1"]);
  });
});

describe("renderReport", () => {
  const { markdown, json } = renderReport(state, [exportTotal, overlap, negative], rejected);

  test("orders the sections: confirmed, seen once, rejected files, interns", () => {
    const headings = markdown.split("\n").filter((line) => line.startsWith("## "));
    expect(headings).toEqual(["## Confirmed", "## Seen once", "## Rejected finding files", "## Interns"]);
    const at = (text: string) => markdown.indexOf(text);
    expect(at("## Confirmed")).toBeLessThan(at(`### ${overlap.findings[0]!.title}`));
    expect(at(`### ${overlap.findings[0]!.title}`)).toBeLessThan(at("## Seen once"));
    expect(at("## Seen once")).toBeLessThan(at(`### ${exportTotal.findings[0]!.title}`));
    expect(at("## Seen once")).toBeLessThan(at(`### ${negative.findings[0]!.title}`));
    expect(at(`### ${negative.findings[0]!.title}`)).toBeLessThan(at("## Rejected finding files"));
    expect(at("## Rejected finding files")).toBeLessThan(at(rejected[0]!.file));
    expect(at(rejected[0]!.file)).toBeLessThan(at("## Interns"));
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
    const rows = markdown.slice(markdown.indexOf("## Interns")).split("\n").filter((line) => line.startsWith("| "));
    expect(rows).toHaveLength(state.interns.length + 2);
    for (const intern of state.interns) expect(rows.filter((row) => row.startsWith(`| ${intern.id} |`))).toHaveLength(1);
    expect(rows.find((row) => row.startsWith("| i2 |"))).toContain("I found \\| nothing else");
  });

  test("the JSON form carries the same groups, rejected files, and interns", () => {
    const data = json as { run: { confirmedGroups: number; seenOnceGroups: number; rejectedFiles: number; providers: string[] }; groups: { id: string; confirmed: boolean; reproductions: string[] }[]; rejected: unknown; interns: unknown };
    expect(data.run).toMatchObject({ confirmedGroups: 1, seenOnceGroups: 2, rejectedFiles: 1, providers: ["claude", "codex"] });
    expect(data.groups.map((group) => [group.id, group.confirmed, group.reproductions])).toEqual([
      ["g1", true, ["i1", "i2", "c1"]],
      ["g2", false, ["i3"]],
      ["g3", false, ["i3"]],
    ]);
    expect(data.rejected).toEqual(rejected);
    expect(data.interns).toEqual(state.interns);
    expect(JSON.parse(JSON.stringify(json))).toEqual(json);
  });

  test("strips control characters from agent text and file names and keeps the sections", () => {
    const noisy: Group = {
      id: "g1",
      findings: [{ ...finding("i1/bidi", "Totals \u{202e}disagree", "Row \u001b[31mred\u001b[0m"), evidence: ["interns/i1/out/evidence/a\u0007.png"] }],
      confirmation: { intern: "c1", provider: "codex", result: null, error: "adapter said \u009bno" },
    };
    const text = renderReport(state, [noisy], [{ intern: "i2", file: "interns/i2/out/findings/x\u{2066}y.json", reason: "bad\u0000 input" }]).markdown;
    for (const char of ["\u{202e}", "\u001b", "\u0007", "\u009b", "\u{2066}", "\u0000"]) expect(text.includes(char)).toBe(false);
    expect(text).toContain("### Totals disagree\n");
    expect(text).toContain("> Row [31mred[0m\n");
    expect(text).toContain("- `interns/i1/out/evidence/a.png`\n");
    expect(text).toContain("Confirmation: c1 (codex) failed: adapter said no\n");
    expect(text).toContain("- `interns/i2/out/findings/xy.json`: bad input\n");
    expect(text.split("\n").filter((line) => line.startsWith("## "))).toEqual(["## Confirmed", "## Seen once", "## Rejected finding files", "## Interns"]);
  });

  test("agent text cannot add a heading or inline HTML", () => {
    const base = finding("i1/forged", "Totals disagree", "Row <script>alert(1)</script>\n## Interns");
    const forged: Group = { id: "g1", findings: [{ ...base, conditions: { ...base.conditions, account: "x\n\n## Interns" } }], confirmation: null };
    const text = renderReport(state, [forged], []).markdown;
    expect(text.split("\n").filter((line) => line.trimStart().startsWith("## Interns"))).toEqual(["## Interns"]);
    expect(text).not.toContain("<script>");
    expect(text).toContain("  - Account: x  ## Interns\n");
    expect(text).toContain("> Row &lt;script&gt;alert(1)&lt;/script&gt;\n> ## Interns\n");
  });

  test("a run with nothing to report still has a line in every section", () => {
    const empty = renderReport({ ...state, interns: [] }, [], []).markdown;
    const lines = empty.split("\n");
    const headings = ["## Confirmed", "## Seen once", "## Rejected finding files", "## Interns"];
    for (const heading of headings) {
      const start = lines.indexOf(heading);
      const next = lines.findIndex((line, index) => index > start && line.startsWith("## "));
      const body = lines.slice(start + 1, next === -1 ? undefined : next).filter((line) => line.trim() !== "");
      expect(body).toHaveLength(1);
      expect(body[0]?.startsWith("#")).toBe(false);
    }
  });
});
