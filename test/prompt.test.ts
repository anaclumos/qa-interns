import { describe, expect, test } from "bun:test";
import { charters, confirmPrompt, continuePrompt, correctionPrompt, deck, internPrompt, judgePrompt, type PromptEnvironment } from "../src/prompt.ts";
import type { Finding } from "../src/types.ts";

const accounts = [
  { email: "owner@acme.test", password: "acme-owner-pass", displayName: "Avery Stone", team: "Acme", role: "owner" },
  { email: "editor@acme.test", password: "acme-editor-pass", displayName: "Eli Park", team: "Acme", role: "editor" },
  { email: "viewer@acme.test", password: "acme-viewer-pass", displayName: "Vera Lind", team: "Acme", role: "viewer" },
  { email: "owner@globex.test", password: "globex-owner-pass", displayName: "Gus Moreno", team: "Globex", role: "owner" },
];

const env: PromptEnvironment = {
  urls: { app: "http://web:3000", mail: "http://mailpit:8025" },
  seed: {
    accounts,
    data: { summary: "Acme has 23 invoices. Globex has 3 invoices.", acmeInvoiceCount: 23, globexInvoiceCount: 3, globexInvoiceId: 24 },
  },
  minutes: 30,
  offLimits: ["Do not change the password of a seeded account."],
};

const knownGaps = ["The environment has no media support.", "The environment has no video model."];
const intendedBehaviors = ["The invoice table scrolls sideways at narrow viewports instead of clipping its columns.", "A Paid invoice cannot be edited."];

function finding(id: string, title: string, evidence: string[]): Finding {
  const intern = id.slice(0, id.indexOf("/"));
  return {
    id,
    intern,
    title,
    kind: "wrong-data",
    conditions: { account: "owner@acme.test, role owner", data: "freshly seeded", viewport: "1280x720", browser: "one tab, signed in", network: "online" },
    steps: ["Sign in as owner@acme.test with the password acme-owner-pass.", "Open http://web:3000/invoices?page=2."],
    observed: "The first row of page 2 reads \"INV-0014 Stark Industries\", the same as the last row of page 1.",
    contradicts: null,
    evidence,
    environment: { commit: "3f9c2e1d8a7b", dirty: false, environment: `qa-1a2b3c4d-${intern}`, provider: "codex", model: "gpt-5.5" },
  };
}

const findings = [
  finding("i1/pagination-overlap", "Invoice INV-0014 appears on page 1 and page 2", ["interns/i1/out/evidence/page-1.png"]),
  finding("i2/page-two-repeats", "Invoice INV-0014 appears on page 1 and page 2", ["interns/i2/out/evidence/page-2.har"]),
  { ...finding("i3/export-total", "CSV export total leaves out tax", ["interns/i3/out/evidence/export.csv"]), kind: "inconsistency" as const, contradicts: "The detail page shows €5,770.60." },
];

describe("deck", () => {
  test("puts one prefixed charter per focus entry before the charters", () => {
    const focus = ["How invoices calculate money across currencies.", "What viewers can change."];
    const cards = deck(focus);
    expect(cards.slice(0, focus.length)).toEqual(["Project focus: How invoices calculate money across currencies.", "Project focus: What viewers can change."]);
    expect(cards.slice(focus.length)).toEqual([...charters]);
    expect(deck([])).toEqual([...charters]);
  });
});

describe("internPrompt", () => {
  const charter = deck(["What viewers can change."]).at(0) ?? "";
  const prompt = internPrompt(charter, env, knownGaps, intendedBehaviors);

  test("carries the charter as its own Charter line", () => {
    expect(prompt.split("\n")).toContain(`Charter: ${charter}`);
  });

  test("lists every known gap in the findings section", () => {
    const lines = prompt.split("\n");
    const findings = lines.slice(lines.indexOf("Findings:"));
    for (const entry of knownGaps) expect(findings).toContain(`  - ${entry}`);
  });

  test("lists every intended behavior in the findings section", () => {
    const lines = prompt.split("\n");
    const findings = lines.slice(lines.indexOf("Findings:"));
    for (const entry of intendedBehaviors) expect(findings).toContain(`  - ${entry}`);
  });

  test("carries no intended behavior section when the target sets none", () => {
    expect(internPrompt(charter, env, knownGaps, [])).not.toContain("intended behavior");
  });

  test("names every URL, every seeded account, and every off-limits entry", () => {
    for (const url of Object.values(env.urls)) expect(prompt).toContain(url);
    for (const account of accounts) {
      expect(prompt).toContain(account.email);
      expect(prompt).toContain(account.password);
    }
    for (const entry of env.offLimits) expect(prompt).toContain(entry);
  });

  test("the first http URL in the prompt is the first application URL", () => {
    const start = prompt.indexOf("http://");
    expect(prompt.slice(start, prompt.indexOf("\n", start))).toBe("http://web:3000");
  });

  test("names the findings folder and evidence folder and no judge or confirmation file", () => {
    expect(prompt).toContain("/qa/out/findings/<slug>.json");
    expect(prompt).toContain("/qa/out/evidence/");
    expect(prompt).not.toContain("/qa/out/groups.json");
    expect(prompt).not.toContain("/qa/out/confirmation.json");
  });
});

describe("continuePrompt", () => {
  test("lists each rejected file at its path inside the runner of its attempt with the reason", () => {
    const prompt = continuePrompt(
      12,
      [
        { intern: "i1", file: "interns/i1/out-2/findings/negative-total.json", reason: "steps must have at least one entry" },
        { intern: "i1", file: "interns/i1/out-2/findings/export.json", reason: "evidence path /qa/out/evidence/a.png does not exist" },
      ],
      "interns/i1/out-2",
    );
    expect(prompt).toContain("12");
    expect(prompt).toContain("/qa/out/findings/negative-total.json: steps must have at least one entry");
    expect(prompt).toContain("/qa/out/findings/export.json: evidence path /qa/out/evidence/a.png does not exist");
  });

  test("names no file an agent keys on", () => {
    for (const prompt of [
      continuePrompt(5, [], "interns/i2/out"),
      continuePrompt(1, [{ intern: "i2", file: "interns/i2/out/findings/x.json", reason: "not valid JSON: Unexpected EOF" }], "interns/i2/out"),
    ]) {
      expect(prompt).not.toContain("Charter:");
      expect(prompt).not.toContain("/qa/out/groups.json");
      expect(prompt).not.toContain("/qa/out/confirmation.json");
    }
  });
});

describe("judgePrompt", () => {
  const prompt = judgePrompt(findings);

  test("names the groups file and no other file an agent keys on", () => {
    expect(prompt).toContain("/qa/out/groups.json");
    expect(prompt).not.toContain("Charter:");
    expect(prompt).not.toContain("/qa/out/confirmation.json");
  });

  test("lists every finding as one JSON line without evidence or environment", () => {
    const listed = prompt
      .split("\n")
      .filter((line) => line.startsWith('{"id":'))
      .map((line) => JSON.parse(line));
    expect(listed.map((item) => item.id)).toEqual(findings.map((item) => item.id));
    for (const item of listed) expect(Object.keys(item)).toEqual(["id", "title", "kind", "conditions", "steps", "observed", "contradicts"]);
    expect(listed[2].contradicts).toBe("The detail page shows €5,770.60.");
    for (const item of findings) for (const file of item.evidence) expect(prompt).not.toContain(file);
  });
});

describe("confirmPrompt", () => {
  const target = findings[2] ?? findings[0];
  if (target === undefined) throw new Error("no finding to confirm");
  const prompt = confirmPrompt(target, { ...env, minutes: 10 }, intendedBehaviors);

  test("names the confirmation file and no other file an agent keys on", () => {
    expect(prompt).toContain("/qa/out/confirmation.json");
    expect(prompt).not.toContain("Charter:");
    expect(prompt).not.toContain("/qa/out/groups.json");
  });

  test("carries the finding and the environment but not the reporter or the evidence", () => {
    for (const step of target.steps) expect(prompt).toContain(JSON.stringify(step));
    expect(prompt).toContain(JSON.stringify(target.observed));
    expect(prompt).toContain(JSON.stringify(target.contradicts));
    expect(prompt).toContain(JSON.stringify(target.conditions.account));
    expect(prompt).not.toContain(target.id);
    expect(prompt).not.toContain(target.environment.environment);
    for (const file of target.evidence) expect(prompt).not.toContain(file);
    for (const account of accounts) expect(prompt).toContain(account.password);
    expect(prompt).toContain("http://web:3000");
  });

  test("lists every intended behavior", () => {
    const lines = prompt.split("\n");
    for (const entry of intendedBehaviors) expect(lines).toContain(`  - ${entry}`);
  });

  test("carries no intended behavior section when the target sets none", () => {
    expect(confirmPrompt(target, { ...env, minutes: 10 }, [])).not.toContain("intended behavior");
  });
});

describe("correctionPrompt", () => {
  test("names the file and the reason", () => {
    const prompt = correctionPrompt("/qa/out/groups.json", "finding id i2/page-two-repeats is missing");
    expect(prompt).toContain("/qa/out/groups.json");
    expect(prompt).toContain("finding id i2/page-two-repeats is missing");
  });

  test("does not start with a slash, which OpenCode reads as a slash command", () => {
    expect(correctionPrompt("/qa/out/groups.json", "finding id i2/page-two-repeats is missing").startsWith("/")).toBe(false);
  });
});
