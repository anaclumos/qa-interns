import { describe, expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import { cp, readdir } from "node:fs/promises";
import { join } from "node:path";
import { ask, runQa } from "../src/run.ts";
import { redact } from "../src/secrets.ts";
import { newRunId, readState } from "../src/state.ts";
import { capture, execute } from "../src/target.ts";
import { disks, dockerAvailable, endToEnd, leftovers, timeout, workspaces } from "./e2e.ts";

describe.skipIf(!dockerAvailable)("end to end with the fake agent", () => {
  const { root, target, fakeImage, logins, askOptions } = endToEnd();

  test(
    "a run replaces every value that secrets names with [redacted] in the files it leaves and the lines it prints",
    async () => {
      const secret = join(root, "secret");
      await cp(target, secret, { recursive: true });
      const file = join(secret, ".devcontainer", "devcontainer.json");
      const config = await Bun.file(file).json();
      const settings = { ...config.customizations["qa-interns"], hostEnv: ["QA_SECRET_TOKEN"], secrets: { hostEnv: ["QA_SECRET_TOKEN"], seed: ["password"] } };
      await Bun.write(file, JSON.stringify({ ...config, initializeCommand: 'echo "initialize with $QA_SECRET_TOKEN" >&2', customizations: { "qa-interns": settings } }));
      const git = ["git", "-C", secret, "-c", "user.name=QA Interns", "-c", "user.email=qa@example.test", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null"];
      await execute([...git, "init", "-q"]);
      await execute([...git, "add", "-A"]);
      await execute([...git, "commit", "-q", "-m", "Ledger with secrets"]);
      const token = `tok_${crypto.randomUUID()}`;
      const passwords = ["acme-owner-pass", "acme-editor-pass", "acme-viewer-pass", "globex-owner-pass"];
      const loginsFile = await logins("secret", { stray: true });

      const lines: string[] = [];
      const previous = process.env.QA_SECRET_TOKEN;
      process.env.QA_SECRET_TOKEN = token;
      const stderr = spyOn(process.stderr, "write");
      let runDir: string;
      let printed: string;
      try {
        runDir = await runQa({ dir: secret, rev: "HEAD", dirty: false, interns: 1, minutes: 0.5, confirmMinutes: 0.5, loginsFile, replay: null, runnerImage: async () => fakeImage, admit: () => () => {}, print: (line) => lines.push(line) });
      } finally {
        printed = stderr.mock.calls.map(([chunk]) => String(chunk)).join("");
        stderr.mockRestore();
        if (previous === undefined) delete process.env.QA_SECRET_TOKEN;
        else process.env.QA_SECRET_TOKEN = previous;
      }
      expect(printed).toContain("Got response to unknown request [redacted]\n");
      expect(printed).toContain("Invalid message\n");
      expect(passwords.filter((value) => printed.includes(value))).toEqual([]);

      const state = await readState(runDir);
      expect(state.phase).toBe("done");
      expect(redact(token)).toBe(token);
      const entries = await readdir(runDir, { recursive: true, withFileTypes: true });
      const files = entries.filter((entry) => entry.isFile()).map((entry) => join(entry.parentPath, entry.name)).filter((path) => !path.startsWith(join(runDir, "source", "")));
      expect(files).toContain(join(runDir, "interns", "c1", "transcript.jsonl"));
      for (const path of files) {
        const text = readFileSync(path, "latin1");
        expect([path, [token, ...passwords].filter((value) => text.includes(value))]).toEqual([path, []]);
      }
      expect([token, ...passwords].filter((value) => lines.join("\n").includes(value))).toEqual([]);
      const text = (path: string[]) => readFileSync(join(runDir, ...path), "utf8");
      expect(text(["envs", "i1", "env.log"])).toContain("initialize with [redacted]");
      expect(text(["interns", "i1", "out", "evidence", "prompt.txt"])).toContain('"password": "[redacted]"');
      expect(text(["interns", "i1", "transcript.jsonl"])).toContain('\\"password\\": \\"[redacted]\\"');
      expect(text(["interns", "i1", "transcript.jsonl"])).toContain('"text":"Signed in as owner@acme.test with [redacted]"');
      expect(text(["interns", "i1", "transcript.jsonl"])).not.toContain("ner-pass.");
      expect(JSON.parse(text(["interns", "i1", "out", "findings", "fake-home.json"])).steps).toContain("Sign in as owner@acme.test with the password [redacted].");
      const report = JSON.parse(text(["findings.json"]));
      expect(report.groups[0].findings[0].steps).toContain("Sign in as owner@acme.test with the password [redacted].");
      expect(text(["report.md"])).toContain("Sign in as owner@acme.test with the password \\[redacted\\].");

      expect(await leftovers(state.runId)).toEqual([]);
      expect(await workspaces(runDir, state)).toEqual([]);
      expect(await disks(runDir, state)).toEqual([]);
    },
    timeout,
  );

  test(
    "a run and ask replace the API key of the login with [redacted] in the files they leave, the lines run prints, and the errors ask throws",
    async () => {
      const fake = { printKey: true as const, nonce: crypto.randomUUID() };
      const key = `fake-agent:${JSON.stringify(fake)}`;
      const loginsFile = await logins("login-key", fake);
      const lines: string[] = [];
      const runDir = await runQa({ dir: target, rev: "HEAD", dirty: false, interns: 1, minutes: 0.5, confirmMinutes: 0.5, loginsFile, replay: null, runnerImage: async () => fakeImage, admit: () => () => {}, print: (line) => lines.push(line) });

      const state = await readState(runDir);
      expect(state.phase).toBe("done");
      const options = { runDir, runId: state.runId, loginsFile, runnerImage: fakeImage, admit: () => () => {} };
      expect(await ask({ ...options, name: "score", prompt: "Write /qa/out/groups.json.", file: "groups.json", parse: (raw) => JSON.parse(raw) })).toEqual({ groups: [] });
      const failed = ask({
        ...options,
        name: "score-fail",
        prompt: "Write /qa/out/evidence/auth.json.",
        file: "evidence/auth.json",
        parse: (raw) => {
          throw new Error(`unreadable ${raw}`);
        },
      });
      await expect(failed).rejects.toThrow('/qa/out/evidence/auth.json is still invalid after one correction: unreadable {"vercel-ai-gateway":{"type":"api_key","key":"[redacted]"}}');
      expect(redact(key)).toBe(key);
      const entries = await readdir(runDir, { recursive: true, withFileTypes: true });
      const files = entries.filter((entry) => entry.isFile()).map((entry) => join(entry.parentPath, entry.name));
      for (const path of files) expect([path, readFileSync(path, "latin1").includes(key)]).toEqual([path, false]);
      expect(lines.join("\n")).not.toContain(key);
      for (const name of ["i1", "score", "score-fail"]) {
        expect(readFileSync(join(runDir, "interns", name, "transcript.jsonl"), "utf8")).toContain('"text":"The login key is [redacted]."');
        expect(JSON.parse(readFileSync(join(runDir, "interns", name, "out", "evidence", "auth.json"), "utf8"))).toEqual({ "vercel-ai-gateway": { type: "api_key", key: "[redacted]" } });
      }

      expect(await leftovers(state.runId)).toEqual([]);
      expect(await workspaces(runDir, state)).toEqual([]);
      expect(await disks(runDir, state)).toEqual([]);
    },
    timeout,
  );

  test(
    "an ask that ends while another ask runs leaves the login key of the other ask in the secret set until that ask ends",
    async () => {
      const fake = { printKey: true as const, nonce: crypto.randomUUID() };
      const key = `fake-agent:${JSON.stringify(fake)}`;
      const loginsFile = await logins("overlap-key", fake);
      const keyed = {
        ...(await askOptions(newRunId(), "keyed")),
        loginsFile,
        prompt: "Write /qa/out/evidence/auth.json.",
        file: "evidence/auth.json",
        parse: (raw: string): unknown => {
          throw new Error(`unreadable ${raw}`);
        },
      };
      const refused = {
        ...(await askOptions(newRunId(), "refused")),
        admit: (): never => {
          throw new Error("refused before the environment starts");
        },
      };
      const running = ask(keyed);
      let ended = false;
      const outcome = Promise.allSettled([running]).finally(() => {
        ended = true;
      });
      while (redact(key) === key && !ended) await Bun.sleep(20);
      expect(ended).toBe(false);
      await expect(ask(refused)).rejects.toThrow("refused before the environment starts");
      expect(redact(key)).toBe("[redacted]");
      const [result] = await outcome;
      expect(result.status).toBe("rejected");
      expect(String((result as PromiseRejectedResult).reason)).toContain('"key":"[redacted]"');
      expect(readFileSync(join(keyed.runDir, "interns", "keyed", "transcript.jsonl"), "utf8")).not.toContain(key);
      expect(redact(key)).toBe(key);
      expect(await leftovers(keyed.runId)).toEqual([]);
      expect(await leftovers(refused.runId)).toEqual([]);
    },
    timeout,
  );

  test(
    "up and a failed up replace every hostEnv value that secrets names with [redacted] in the files they leave, and a running up leaves its live workspace untouched",
    async () => {
      const secret = join(root, "up-secret");
      await cp(target, secret, { recursive: true });
      const file = join(secret, ".devcontainer", "devcontainer.json");
      const config = await Bun.file(file).json();
      const settings = { ...config.customizations["qa-interns"], hostEnv: ["QA_SECRET_TOKEN"], secrets: { hostEnv: ["QA_SECRET_TOKEN"] } };
      const initializeCommand = 'echo "initialize with $QA_SECRET_TOKEN" >&2 && printf %s "$QA_SECRET_TOKEN" > live-secret.txt';
      await Bun.write(file, JSON.stringify({ ...config, initializeCommand, customizations: { "qa-interns": settings } }));
      const git = ["git", "-C", secret, "-c", "user.name=QA Interns", "-c", "user.email=qa@example.test", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null"];
      await execute([...git, "init", "-q"]);
      await execute([...git, "add", "-A"]);
      await execute([...git, "commit", "-q", "-m", "Ledger with a secret"]);
      await Bun.write(file, JSON.stringify({ ...config, initializeCommand, customizations: { "qa-interns": { ...settings, seed: "echo not-json" } } }));
      await execute([...git, "commit", "-q", "-a", "-m", "Broken seed"]);
      const token = `tok_${crypto.randomUUID()}`;
      const cli = (...args: string[]) =>
        capture([process.execPath, join(import.meta.dir, "..", "src", "cli.ts"), ...args], { env: { ...process.env, QA_SECRET_TOKEN: token } });
      const leaks = async (runDir: string) => {
        const entries = await readdir(runDir, { recursive: true, withFileTypes: true });
        const files = entries.filter((entry) => entry.isFile()).map((entry) => join(entry.parentPath, entry.name)).filter((path) => !path.startsWith(join(runDir, "source", "")));
        return files.filter((path) => readFileSync(path, "latin1").includes(token));
      };

      const up = await cli("up", secret, "--commit", "HEAD~1");
      const runDir = up.stdout.split("\n")[0] ?? "";
      try {
        expect(up).toMatchObject({ code: 0 });
        const live = join(runDir, "envs", "up", `qa-${(await readState(runDir)).runId}-up`, "live-secret.txt");
        expect(await leaks(runDir)).toEqual([live]);
        expect(readFileSync(live, "utf8")).toBe(token);
        expect(readFileSync(join(runDir, "envs", "up", "env.log"), "utf8")).toContain("initialize with [redacted]");
      } finally {
        if (runDir !== "") expect(await cli("down", runDir)).toMatchObject({ code: 0 });
      }

      const broken = await cli("up", secret);
      expect(broken.code).toBe(1);
      const failedDir = broken.stdout.split("\n")[0] ?? "";
      expect(await readState(failedDir)).toMatchObject({ phase: "failed" });
      expect(await leaks(failedDir)).toEqual([]);
      expect(readFileSync(join(failedDir, "envs", "up", "env.log"), "utf8")).toContain("initialize with [redacted]");
      expect(await leftovers((await readState(failedDir)).runId)).toEqual([]);
    },
    timeout,
  );
});
