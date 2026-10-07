import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rename, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseGroups, readConfirmation, readFindings } from "../src/findings.ts";
import type { FindingEnvironment } from "../src/types.ts";

const asRoot = process.getuid?.() === 0;

const environment: FindingEnvironment = { commit: "3f9c2e1d8a7b6c5d4e3f2a1b0c9d8e7f6a5b4c3d", dirty: false, environment: "qa-1a2b3c4d-i1", provider: "claude", model: "claude-opus-5-5" };

const pagination = {
  title: "Invoice INV-0014 appears on both page 1 and page 2 of the invoices list",
  kind: "wrong-data",
  conditions: {
    account: "owner@acme.test, role owner",
    data: "freshly seeded, 23 Acme invoices",
    viewport: "1280x720",
    browser: "one tab, signed in, time zone UTC",
    network: "online",
  },
  steps: [
    "Open http://web:3000/signin.",
    "Sign in as owner@acme.test with the password acme-owner-pass.",
    "Open http://web:3000/invoices and note the last row.",
    "Open http://web:3000/invoices?page=2 and note the first row.",
  ],
  observed: "The last row of page 1 reads \"INV-0014 Stark Industries\", and the first row of page 2 reads \"INV-0014 Stark Industries\".",
  evidence: ["/qa/out/evidence/page-1.png", "evidence/page-2.png"],
};

const exportTotal = {
  title: "CSV export total for INV-0002 differs from the list and detail pages",
  kind: "inconsistency",
  conditions: {
    account: "owner@acme.test, role owner",
    data: "freshly seeded",
    viewport: "1280x720",
    browser: "one tab, signed in",
    network: "online",
  },
  steps: ["Sign in as owner@acme.test with the password acme-owner-pass.", "Download http://web:3000/invoices/export.csv."],
  observed: "The CSV row for INV-0002 has the total 5246.00.",
  contradicts: "The invoices list at /invoices and the detail page at /invoices/2 show the total €5,770.60.",
  evidence: ["/qa/out/evidence/export.csv"],
};

let runDir = "";
let outside = "";

async function write(intern: string, file: string, content: string) {
  await Bun.write(path.join(runDir, "interns", intern, "out", file), content);
}

async function finding(intern: string, name: string, value: unknown) {
  await write(intern, `findings/${name}.json`, JSON.stringify(value, null, 2));
}

async function reasonOf(name: string) {
  const { rejected } = await readFindings(runDir, "i2", 1, environment);
  const entry = rejected.find((item) => item.file === `interns/i2/out/findings/${name}.json`);
  if (entry === undefined) throw new Error(`${name}.json was not rejected`);
  return entry.reason;
}

async function reasonFor(name: string, value: unknown) {
  await finding("i2", name, value);
  return reasonOf(name);
}

function mkfifo(file: string) {
  const made = Bun.spawnSync(["mkfifo", file], { stderr: "pipe" });
  if (made.exitCode !== 0) throw new Error(made.stderr.toString());
}

function findingPath(intern: string, name: string) {
  return path.join(runDir, "interns", intern, "out", "findings", `${name}.json`);
}

beforeAll(async () => {
  runDir = await mkdtemp(path.join(os.tmpdir(), "qa-findings-run-"));
  outside = await mkdtemp(path.join(os.tmpdir(), "qa-findings-outside-"));
  await Bun.write(path.join(outside, "secret.txt"), "host file");
  for (const intern of ["i1", "i2"]) {
    await write(intern, "evidence/page-1.png", "png bytes");
    await write(intern, "evidence/page-2.png", "png bytes");
    await write(intern, "evidence/export.csv", "Number,Total\nINV-0002,5246.00\n");
  }
});

afterAll(async () => {
  await rm(runDir, { recursive: true });
  await rm(outside, { recursive: true });
});

describe("readFindings", () => {
  test("a missing findings folder gives zero findings", async () => {
    expect(await readFindings(runDir, "i9", 1, environment)).toEqual({ findings: [], rejected: [] });
  });

  test("accepts valid findings, adds id, intern, and environment, and rewrites evidence to run-relative paths", async () => {
    await finding("i1", "pagination-overlap", pagination);
    await finding("i1", "export-total", exportTotal);
    await write("i1", "findings/notes.txt", "not a finding");
    await write("i1", "findings/draft.json.tmp", "{");
    const { findings, rejected } = await readFindings(runDir, "i1", 1, environment);
    expect(rejected).toEqual([]);
    expect(findings.map((item) => item.id)).toEqual(["i1/export-total", "i1/pagination-overlap"]);
    const overlap = findings.find((item) => item.id === "i1/pagination-overlap");
    expect(overlap).toEqual({
      id: "i1/pagination-overlap",
      intern: "i1",
      title: pagination.title,
      kind: "wrong-data",
      conditions: pagination.conditions,
      steps: pagination.steps,
      observed: pagination.observed,
      contradicts: null,
      evidence: ["interns/i1/out/evidence/page-1.png", "interns/i1/out/evidence/page-2.png"],
      environment,
    });
    for (const file of overlap?.evidence ?? []) expect(await Bun.file(path.join(runDir, file)).exists()).toBe(true);
    expect(findings.find((item) => item.id === "i1/export-total")?.contradicts).toBe(exportTotal.contradicts);
  });

  test("rejects a file that is not valid JSON with the parse error", async () => {
    await write("i2", "findings/broken.json", '{"title": "Save button does nothing",');
    const { rejected } = await readFindings(runDir, "i2", 1, environment);
    const entry = rejected.find((item) => item.file === "interns/i2/out/findings/broken.json");
    expect(entry?.intern).toBe("i2");
    expect(entry?.reason.startsWith("not valid JSON: ")).toBe(true);
    expect(entry?.reason.length).toBeGreaterThan("not valid JSON: ".length);
  });

  test("rejects a missing evidence file and names the path", async () => {
    const reason = await reasonFor("missing-evidence", { ...pagination, evidence: ["/qa/out/evidence/a.png"] });
    expect(reason).toBe("evidence path /qa/out/evidence/a.png does not exist");
  });

  test("rejects evidence outside /qa/out, by absolute path, by relative path, and through a symlink", async () => {
    expect(await reasonFor("absolute-outside", { ...pagination, evidence: ["/etc/passwd"] })).toBe("evidence path /etc/passwd is outside /qa/out");
    expect(await reasonFor("relative-outside", { ...pagination, evidence: ["../../../state.json"] })).toBe(
      "evidence path ../../../state.json is outside /qa/out",
    );
    await symlink(path.join(outside, "secret.txt"), path.join(runDir, "interns", "i2", "out", "evidence", "link.txt"));
    expect(await reasonFor("symlink-outside", { ...pagination, evidence: ["evidence/link.txt"] })).toBe(
      "evidence path evidence/link.txt resolves outside /qa/out",
    );
  });

  test("rejects a directory as evidence", async () => {
    expect(await reasonFor("directory-evidence", { ...pagination, evidence: ["/qa/out/evidence"] })).toBe(
      "evidence path /qa/out/evidence is not a file",
    );
  });

  test("rejects evidence whose real path holds a control character, which removing would turn into another path", async () => {
    const real = `evidence/a/${".\u0001./".repeat(8)}shot.png`;
    await write("i2", real, "png bytes");
    await symlink(path.join(runDir, "interns", "i2", "out", real), path.join(runDir, "interns", "i2", "out", "evidence", "escape.png"));
    expect(await reasonFor("control-real-path", { ...pagination, evidence: ["evidence/escape.png"] })).toBe(
      "evidence path evidence/escape.png resolves to a path with a control character",
    );
    await write("c9", real, "png bytes");
    await symlink(path.join(runDir, "interns", "c9", "out", real), path.join(runDir, "interns", "c9", "out", "evidence", "escape.png"));
    await write("c9", "confirmation.json", JSON.stringify({ steps: true, task: true, observed: "Same.", evidence: ["evidence/escape.png"] }));
    await expect(readConfirmation(runDir, "c9", 1)).rejects.toThrow("evidence path evidence/escape.png resolves to a path with a control character");
  });

  test("rejects empty steps", async () => {
    expect(await reasonFor("empty-steps", { ...pagination, steps: [] })).toBe("steps must have at least one entry");
  });

  test("rejects an inconsistency without contradicts", async () => {
    const rest: Record<string, unknown> = { ...exportTotal };
    delete rest.contradicts;
    expect(await reasonFor("no-contradicts", rest)).toBe("contradicts is required when kind is inconsistency");
  });

  test("rejects an unknown kind, a missing condition, an empty step, a multi-line title, and extra fields in one reason", async () => {
    const conditions: Record<string, string> = { ...pagination.conditions };
    delete conditions.network;
    const reason = await reasonFor("many-problems", {
      ...pagination,
      title: "Totals disagree\nacross pages",
      kind: "bug",
      conditions,
      steps: ["Open http://web:3000/invoices.", ""],
      severity: "high",
    });
    expect(reason.split("; ")).toEqual([
      "title must be one line",
      "kind must be one of crash, error, wrong-data, data-loss, inconsistency, access, visual, slow",
      "conditions.network is required",
      "steps[1] must be a non-empty string",
      "the file has unknown fields severity (the allowed fields are title, kind, conditions, steps, observed, contradicts, evidence)",
    ]);
  });

  test("rejects a file that holds an array", async () => {
    expect(await reasonFor("array", [pagination])).toBe("the file must be one JSON object");
  });

  test("rejects a findings folder that is a file", async () => {
    await write("f1", "findings", "not a folder");
    expect(await readFindings(runDir, "f1", 1, environment)).toEqual({
      findings: [],
      rejected: [{ intern: "f1", file: "interns/f1/out/findings", reason: "the findings folder is a symbolic link or not a directory" }],
    });
  });

  const unreadable: [string, string, string][] = [
    ["the findings folder", "f3", "out/findings"],
    ["the out folder", "f4", "out"],
  ];

  test.skipIf(asRoot).each(unreadable)("rejects a findings folder it cannot read when %s has mode 000", async (_, intern, locked) => {
    await finding(intern, "pagination-overlap", pagination);
    const dir = path.join(runDir, "interns", intern, locked);
    await chmod(dir, 0o000);
    try {
      expect(await readFindings(runDir, intern, 1, environment)).toEqual({
        findings: [],
        rejected: [{ intern, file: `interns/${intern}/out/findings`, reason: "the findings folder is not readable" }],
      });
    } finally {
      await chmod(dir, 0o755);
    }
  });

  test("rejects a findings folder that is a symlink to a folder outside the out dir", async () => {
    await Bun.write(path.join(outside, "findings", "planted.json"), JSON.stringify({ ...pagination, evidence: [] }));
    await mkdir(path.join(runDir, "interns", "f2", "out"), { recursive: true });
    await symlink(path.join(outside, "findings"), path.join(runDir, "interns", "f2", "out", "findings"));
    expect(await readFindings(runDir, "f2", 1, environment)).toEqual({
      findings: [],
      rejected: [{ intern: "f2", file: "interns/f2/out/findings", reason: "the findings folder is a symbolic link or not a directory" }],
    });
  });

  test("rejects the findings folder when it is swapped for a symlink between two reads", async () => {
    await finding("s1", "pagination-overlap", { ...pagination, evidence: [] });
    expect((await readFindings(runDir, "s1", 1, environment)).findings.map((item) => item.id)).toEqual(["s1/pagination-overlap"]);
    const out = path.join(runDir, "interns", "s1", "out");
    await Bun.write(path.join(outside, "swapped", "planted.json"), JSON.stringify({ ...pagination, evidence: [] }));
    await rename(path.join(out, "findings"), path.join(out, "findings-before"));
    await symlink(path.join(outside, "swapped"), path.join(out, "findings"));
    expect(await readFindings(runDir, "s1", 1, environment)).toEqual({
      findings: [],
      rejected: [{ intern: "s1", file: "interns/s1/out/findings", reason: "the findings folder is a symbolic link or not a directory" }],
    });
  });

  test("strips control characters before validating, keeps zero-width joiners, and rejects a title of only control characters", async () => {
    await finding("b1", "control-title", { ...pagination, title: "\u0007\u{202e}\u0000", evidence: [] });
    await finding("b1", "bidi-title", { ...pagination, title: "Totals \u{202e}disagree\u{2069} for \u{1f469}\u{200d}\u{1f4bb}", evidence: [] });
    const { findings, rejected } = await readFindings(runDir, "b1", 1, environment);
    expect(findings.map((item) => [item.id, item.title])).toEqual([["b1/bidi-title", "Totals disagree for \u{1f469}\u{200d}\u{1f4bb}"]]);
    expect(rejected).toEqual([{ intern: "b1", file: "interns/b1/out/findings/control-title.json", reason: "title must be a non-empty string" }]);
  });

  test("rejects a finding file whose name holds a control character", async () => {
    await finding("i2", "bell\u0007", pagination);
    expect(await reasonOf("bell\u0007")).toBe("the file name contains a control character");
  });

  test("rejects a finding file that is a symlink to a file outside the out dir", async () => {
    await Bun.write(path.join(outside, "planted.json"), JSON.stringify({ ...pagination, evidence: [] }));
    await symlink(path.join(outside, "planted.json"), findingPath("i2", "planted"));
    expect(await reasonOf("planted")).toBe("the file is a symbolic link");
  });

  test("rejects a FIFO finding file without waiting for a writer", async () => {
    mkfifo(findingPath("i2", "pipe"));
    expect(await reasonOf("pipe")).toBe("the file is not a regular file");
  });

  test.skipIf(asRoot)("rejects a finding file it cannot read", async () => {
    await finding("i2", "locked", pagination);
    await chmod(findingPath("i2", "locked"), 0o000);
    expect(await reasonOf("locked")).toBe("the file is not readable");
  });

  test("rejects a finding file above 1 MiB", async () => {
    await finding("i2", "huge", { ...pagination, observed: "x".repeat(1024 ** 2) });
    expect(await reasonOf("huge")).toBe("the file is above the limit of 1 MiB");
  });

  test("reads a later attempt from its own folder, with ids and evidence paths that name that folder", async () => {
    await finding("a1", "pagination-overlap", { ...pagination, evidence: [] });
    await Bun.write(path.join(runDir, "interns", "a1", "out-2", "evidence", "page-1.png"), "png bytes");
    await Bun.write(path.join(runDir, "interns", "a1", "out-2", "findings", "pagination-overlap.json"), JSON.stringify({ ...pagination, evidence: ["/qa/out/evidence/page-1.png"] }));
    await Bun.write(path.join(runDir, "interns", "a1", "out-2", "findings", "broken.json"), "{");
    const later = await readFindings(runDir, "a1", 2, environment);
    expect(later.findings.map((item) => [item.id, item.intern, item.evidence])).toEqual([["a1/out-2/pagination-overlap", "a1", ["interns/a1/out-2/evidence/page-1.png"]]]);
    expect(later.rejected.map((item) => item.file)).toEqual(["interns/a1/out-2/findings/broken.json"]);
    expect((await readFindings(runDir, "a1", 1, environment)).findings.map((item) => item.id)).toEqual(["a1/pagination-overlap"]);
  });

  test("accepts null contradicts for a kind other than inconsistency", async () => {
    await finding("i1", "null-contradicts", { ...pagination, contradicts: null, evidence: [] });
    const { findings } = await readFindings(runDir, "i1", 1, environment);
    const item = findings.find((entry) => entry.id === "i1/null-contradicts");
    expect(item?.contradicts).toBeNull();
    expect(item?.evidence).toEqual([]);
  });
});

describe("parseGroups", () => {
  const ids = ["i1/pagination-overlap", "i2/page-two-repeats-row", "i3/export-total"];

  test("returns the groups of a valid file", () => {
    const raw = JSON.stringify({ groups: [["i1/pagination-overlap", "i2/page-two-repeats-row"], ["i3/export-total"]] });
    expect(parseGroups(raw, ids)).toEqual([["i1/pagination-overlap", "i2/page-two-repeats-row"], ["i3/export-total"]]);
  });

  test("names a missing id", () => {
    const raw = JSON.stringify({ groups: [["i1/pagination-overlap", "i2/page-two-repeats-row"]] });
    expect(() => parseGroups(raw, ids)).toThrow("finding id i3/export-total is missing");
  });

  test("names a duplicate id", () => {
    const raw = JSON.stringify({ groups: [["i1/pagination-overlap", "i2/page-two-repeats-row"], ["i2/page-two-repeats-row", "i3/export-total"]] });
    expect(() => parseGroups(raw, ids)).toThrow("finding id i2/page-two-repeats-row appears twice");
  });

  test("names an unknown id", () => {
    const raw = JSON.stringify({ groups: [["i1/pagination-overlap", "i2/page-two-repeats-row"], ["i3/export-total"], ["i4/made-up"]] });
    expect(() => parseGroups(raw, ids)).toThrow("finding id i4/made-up is not one of the listed findings");
  });

  test("rejects the wrong shape", () => {
    expect(() => parseGroups(JSON.stringify([["i1/pagination-overlap"]]), ids)).toThrow("the file must be one JSON object with the field groups");
    expect(() => parseGroups(JSON.stringify({ groups: "i1/pagination-overlap" }), ids)).toThrow(
      "groups must be an array of groups, each an array of finding ids",
    );
    expect(() => parseGroups(JSON.stringify({ groups: [ids, []] }), ids)).toThrow("groups[1] must have at least one finding id");
    expect(() => parseGroups(JSON.stringify({ grouping: [ids] }), ids)).toThrow("groups is required");
  });

  test("rejects a file that is not valid JSON", () => {
    expect(() => parseGroups('{"groups": [["i1/pagination-overlap"]', ids)).toThrow("not valid JSON: ");
  });
});

describe("readConfirmation", () => {
  test("reads a valid confirmation and rewrites its evidence", async () => {
    await write("c1", "evidence/repeat.png", "png bytes");
    await write(
      "c1",
      "confirmation.json",
      JSON.stringify({ steps: true, task: true, observed: "Page 2 starts with \"INV-0014 Stark Industries\", the last row of page 1.", evidence: ["/qa/out/evidence/repeat.png"] }),
    );
    expect(await readConfirmation(runDir, "c1", 1)).toEqual({
      steps: true,
      task: true,
      observed: "Page 2 starts with \"INV-0014 Stark Industries\", the last row of page 1.",
      evidence: ["interns/c1/out/evidence/repeat.png"],
    });
  });

  test("reads a later attempt from its own folder", async () => {
    await Bun.write(path.join(runDir, "interns", "c7", "out-2", "evidence", "repeat.png"), "png bytes");
    await Bun.write(
      path.join(runDir, "interns", "c7", "out-2", "confirmation.json"),
      JSON.stringify({ steps: true, task: false, observed: "The steps open page 2 twice. The page's Next link shows INV-0013 first.", evidence: ["evidence/repeat.png"] }),
    );
    expect(await readConfirmation(runDir, "c7", 2)).toEqual({
      steps: true,
      task: false,
      observed: "The steps open page 2 twice. The page's Next link shows INV-0013 first.",
      evidence: ["interns/c7/out-2/evidence/repeat.png"],
    });
    await expect(readConfirmation(runDir, "c7", 1)).rejects.toThrow("the file does not exist");
  });

  test("throws when the file does not exist", async () => {
    await expect(readConfirmation(runDir, "c2", 1)).rejects.toThrow("the file does not exist");
  });

  test("throws when steps is not a boolean or task is missing", async () => {
    await write("c3", "confirmation.json", JSON.stringify({ steps: "yes", observed: "The row repeats.", evidence: [] }));
    await expect(readConfirmation(runDir, "c3", 1)).rejects.toThrow("steps must be true or false; task is required");
  });

  test("throws on a confirmation with one reproduced result instead of steps and task", async () => {
    await write("c8", "confirmation.json", JSON.stringify({ reproduced: true, observed: "The row repeats.", evidence: [] }));
    await expect(readConfirmation(runDir, "c8", 1)).rejects.toThrow("has unknown fields reproduced (the allowed fields are steps, task, observed, evidence)");
  });

  test("throws when confirmation.json is a symlink or a FIFO", async () => {
    await Bun.write(path.join(outside, "confirmation.json"), JSON.stringify({ steps: true, task: true, observed: "Planted outside the out dir.", evidence: [] }));
    await mkdir(path.join(runDir, "interns", "c5", "out"), { recursive: true });
    await symlink(path.join(outside, "confirmation.json"), path.join(runDir, "interns", "c5", "out", "confirmation.json"));
    await expect(readConfirmation(runDir, "c5", 1)).rejects.toThrow("the file is a symbolic link");
    await mkdir(path.join(runDir, "interns", "c6", "out"), { recursive: true });
    mkfifo(path.join(runDir, "interns", "c6", "out", "confirmation.json"));
    await expect(readConfirmation(runDir, "c6", 1)).rejects.toThrow("the file is not a regular file");
  });

  test("throws when an evidence file does not exist", async () => {
    await write("c4", "confirmation.json", JSON.stringify({ steps: false, task: false, observed: "Page 2 starts with INV-0013.", evidence: ["evidence/none.png"] }));
    await expect(readConfirmation(runDir, "c4", 1)).rejects.toThrow("evidence path evidence/none.png does not exist");
  });
});
