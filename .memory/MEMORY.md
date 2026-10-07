# Memory: qa-interns

- A killed `bun test` or run leaves each attempt's output disk holder container and tmpfs volume (label `qa-interns.out`), whose files exist nowhere else; clean a leftover root with `removeDir(dir)` from `src/environment.ts` before anything deletes it, or with `bun src/cli.ts down <run dir>` when the run wrote its `state.json`. [source: https://github.com/anaclumos/qa-interns/issues/175]
- `Bun.spawn` and `Bun.spawnSync` without an `env` option pass the environment the process started with and ignore later `process.env` writes, so a test that sets `XDG_STATE_HOME`, `PATH`, or `QA_INTERNS_SUBNET` in-process and then spawns the CLI or Compose passes `env: { ...process.env }`, or the child writes runs into the real state directory or reads the host's `COMPOSE_PROFILES`. [source: https://github.com/anaclumos/qa-interns/pull/68]
- A `ci.yml` `test` job that prints nothing after `Scheduler > leases the first login in file order ...` in `test/logins.test.ts` and ends `The operation was canceled.` at `timeout-minutes: 45` is the Bun 1.4.2 `Bun.spawnSync` hang (oven-sh/bun#34069) reached through `flock()` in `src/logins.ts`, which no per-test `--timeout` can stop; rerun the job, and bump `bun-version` in `ci.yml` and `@types/bun` in `package.json` together once a Bun release holds the fix. [source: https://github.com/anaclumos/qa-interns/issues/239]

## Index
- [[test_suite]]
- [[environment]]
- [[run_lifecycle]]
- [[providers]]
- [[agent_browser]]
- [[ledger_eval]]
