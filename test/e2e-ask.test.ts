import { describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { removeCopies } from "../src/environment.ts";
import { ask, runQa } from "../src/run.ts";
import { newRunId, readState } from "../src/state.ts";
import { capture, execute } from "../src/target.ts";
import { dockerAvailable, endToEnd, internalSubnet, leftovers, runLocks, timeout } from "./e2e.ts";
import { freeBlock } from "./subnet.ts";
import { suiteLabel } from "./suite-lock.ts";

describe.skipIf(!dockerAvailable)("end to end with the fake agent", () => {
  const { id, root, target, fakeImage, logins, askOptions } = endToEnd();

  test(
    "environments start in a block of the range that QA_INTERNS_SUBNET sets that no Docker network overlaps, a queued confirmation takes the one free block after the one before it, and a run fails when every block overlaps one",
    async () => {
      const third = await freeBlock(214);
      const subnet = `10.214.${third}.0/22`;
      const blockers: string[] = [];
      const block = async (range: string) => {
        const name = `qair-f-e2e-${id}-range-${blockers.length}`;
        await execute(["docker", "network", "create", "--internal", "--label", suiteLabel, "--subnet", range, name]);
        blockers.push(name);
      };
      const previous = process.env.QA_INTERNS_SUBNET;
      process.env.QA_INTERNS_SUBNET = subnet;
      try {
        await block(`10.214.${third}.0/25`);
        const loginsFile = await logins("range", [{ id: "claude-1", provider: "claude", second: true }]);
        const run = () => runQa({ dir: target, rev: "HEAD", dirty: false, interns: 1, minutes: 0.5, confirmMinutes: 0.5, loginsFile, replay: null, runnerImage: async () => fakeImage, print: () => {} });
        const runDir = await run();
        const state = await readState(runDir);
        expect(state.phase).toBe("done");
        expect(state.interns.map((entry) => [entry.id, entry.status])).toEqual([
          ["i1", "done"],
          ["judge", "done"],
          ["c1", "done"],
          ["c2", "done"],
        ]);
        for (const internId of ["i1", "judge", "c1", "c2"]) expect(internalSubnet(runDir, internId)).toBe(`10.214.${third + 2}.0/25`);
        expect(await leftovers(state.runId)).toEqual([]);

        await block(`10.214.${third + 3}.128/25`);
        await expect(run()).rejects.toThrow(`No free network slot: every /23 block of QA_INTERNS_SUBNET ${subnet} overlaps a Docker network or a host route`);
      } finally {
        if (previous === undefined) delete process.env.QA_INTERNS_SUBNET;
        else process.env.QA_INTERNS_SUBNET = previous;
        if (blockers.length > 0) await execute(["docker", "network", "rm", ...blockers]);
      }
    },
    timeout,
  );

  test(
    "ask returns the file the agent wrote, leaves nothing of its environment, and leaves other projects of the run alone",
    async () => {
      const runId = newRunId();
      const other = `qair-f-e2e-other-${runId}`;
      const sibling = join(root, "asks", runId, "envs", "i1", `qa-${runId}-i1`, "marker");
      await Bun.write(sibling, "sibling copy\n");
      await execute(["docker", "network", "create", "--internal", "--label", `com.docker.compose.project=qa-${runId}-i1`, "--label", suiteLabel, other]);
      try {
        expect(await ask(await askOptions(runId, "score"))).toEqual({ groups: [] });
        expect((await capture(["docker", "network", "inspect", other])).code).toBe(0);
      } finally {
        if ((await capture(["docker", "network", "inspect", other])).code === 0) await execute(["docker", "network", "rm", other]);
      }
      expect(await leftovers(runId)).toEqual([]);
      expect(await readdir(join(root, "asks", runId, "interns", "score"))).not.toContain("out.img");
      expect(await readdir(join(root, "asks", runId, "envs", "score"))).not.toContain("tmp");
      expect(await Bun.file(sibling).text()).toBe("sibling copy\n");
    },
    timeout,
  );

  test(
    "ask fails when its environment cannot be torn down, after removing what it can",
    async () => {
      const runId = newRunId();
      const project = `qa-${runId}-score`;
      const held = `qair-f-e2e-held-${runId}`;
      await execute(["docker", "network", "create", "--internal", "--label", `com.docker.compose.project=${project}`, "--label", suiteLabel, held]);
      try {
        await execute(["docker", "run", "-d", "--rm", "--label", suiteLabel, "--name", held, "--network", held, fakeImage]);
        await expect(ask(await askOptions(runId, "score"))).rejects.toThrow(`Teardown of ${project} failed: score: docker compose down left objects of ${project} behind`);
      } finally {
        await execute(["docker", "rm", "-f", held]);
        await execute(["docker", "network", "rm", held]);
        await removeCopies(join(root, "asks", runId), runId, fakeImage);
        rmSync(join(runLocks, runId), { force: true });
      }
      expect(await leftovers(runId)).toEqual([]);
      expect(await readdir(join(root, "asks", runId, "interns", "score"))).not.toContain("out.img");
    },
    timeout,
  );

  test(
    "ask waits for a login that another process holds and runs once that process ends, and fails at once when no process holds a login",
    async () => {
      const runId = newRunId();
      const options = await askOptions(runId, "score");
      const script = join(root, "holder.ts");
      await Bun.write(
        script,
        [
          `import { loadLogins, Scheduler } from ${JSON.stringify(join(import.meta.dir, "..", "src", "logins.ts"))};`,
          "const lease = await new Scheduler(await loadLogins(process.argv[2])).acquire(\"h1\");",
          "console.log(lease === null ? \"none\" : \"held\");",
          "for await (const _ of Bun.stdin.stream()) {}",
          "",
        ].join("\n"),
      );
      const holder = Bun.spawn([process.execPath, script, options.loginsFile], { env: { ...process.env }, stdin: "pipe", stdout: "pipe", stderr: "inherit" });
      try {
        const { value } = await holder.stdout.getReader().read();
        expect(new TextDecoder().decode(value).trim()).toBe("held");
        let settled = false;
        const answer = ask(options).finally(() => {
          settled = true;
        });
        await Bun.sleep(3_000);
        expect(settled).toBe(false);
        holder.stdin.end();
        await holder.exited;
        expect(await answer).toEqual({ groups: [] });
      } finally {
        holder.kill("SIGKILL");
        await holder.exited;
      }
      expect(await leftovers(runId)).toEqual([]);

      const seatless = await askOptions(newRunId(), "score");
      const file = join(root, `seatless-${runId}-logins.json`);
      await Bun.write(file, JSON.stringify({ logins: [{ id: "claude-seatless", provider: "claude", seat: ["false"] }] }));
      await expect(ask({ ...seatless, loginsFile: file })).rejects.toThrow("No login has spare capacity for score");
      expect(await leftovers(seatless.runId)).toEqual([]);
    },
    timeout,
  );

  test(
    "two asks that share one login and the one free block of QA_INTERNS_SUBNET both run, the second once the first has removed its networks",
    async () => {
      const third = await freeBlock(215);
      const blocker = `qair-f-e2e-${id}-shared`;
      await execute(["docker", "network", "create", "--internal", "--label", suiteLabel, "--subnet", `10.215.${third}.0/25`, blocker]);
      const previous = process.env.QA_INTERNS_SUBNET;
      process.env.QA_INTERNS_SUBNET = `10.215.${third}.0/22`;
      try {
        const first = await askOptions(newRunId(), "first");
        const second = { ...(await askOptions(newRunId(), "second")), loginsFile: first.loginsFile };
        expect(await Promise.allSettled([ask(first), ask(second)])).toEqual([
          { status: "fulfilled", value: { groups: [] } },
          { status: "fulfilled", value: { groups: [] } },
        ]);
        expect(await leftovers(first.runId)).toEqual([]);
        expect(await leftovers(second.runId)).toEqual([]);
      } finally {
        if (previous === undefined) delete process.env.QA_INTERNS_SUBNET;
        else process.env.QA_INTERNS_SUBNET = previous;
        await execute(["docker", "network", "rm", blocker]);
      }
    },
    timeout,
  );
});
