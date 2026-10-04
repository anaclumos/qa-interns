# Agent rules

Repo-specific rules only. The owner's global rules load alongside this file; where this file is silent, the global rule applies. The product design is issue #1; user documentation is `README.md`.

## Layout

- `src/`: the orchestrator CLI (`src/cli.ts`), Bun and TypeScript.
- `runner/`: the runner image, the runner's egress proxy, and the target's relay. The image tag is derived from these files and the host uid and gid, so any edit rebuilds it on the next run.
- `skills/qa-interns/` and `.claude-plugin/`: the Claude Code plugin. It has one skill and no hooks.
- `eval/ledger/`: the evaluation target. `eval/defects.json` is the only place its planted defects are described; the application code carries no hint of them.
- `test/`: `bun test`. Tests that need Docker skip when `docker info` fails.

## Gates

- `bun run typecheck` and `bun test` pass before every commit.
- `bun test` loads `test/suite-lock.ts` through `bunfig.toml`, which holds an exclusive `flock` on `$XDG_RUNTIME_DIR/qa-interns/suite.lock` until the suite exits, so the suites of one user on one host run one at a time.
- `claude plugin validate .` and `claude plugin validate skills` pass after any change to `.claude-plugin/` or `skills/`.
- The lefthook `pre-push` hook in `lefthook.yml` runs the install, typecheck, plugin validate, and test commands of the `ci.yml` `test` job, after it checks for a clean tree and a running Docker daemon. `bun install` installs the hook. A change to one of those commands in one file makes the same change in the other. A job that runs git in another repository first runs `unset $(git rev-parse --local-env-vars)`: git exports `GIT_DIR` to hooks, and without the unset the test fixtures commit into this repository and set its `core.bare`.

## Invariants

- An intern never fixes, suggests, ranks, or explains. Prompts, the report, the ticket drafts, and the finding format carry no field or instruction for any of those.
- Interns run Pi through `@automatalabs/pi-acp` on one login, an OpenRouter API key. QA Interns has no other agent, no login fallback, no seat command, and no quota command.
- No MCP anywhere. Every `session/new` sends `mcpServers: []`, and the adapter connects only the servers that list names. Pi 0.87.1, which the adapter pins, has no MCP client of its own, so an MCP server reaches a session only through a Pi extension. The runner sets `PI_CODING_AGENT_DIR` to an empty tmpfs and mounts only `auth.json` from the store, read-only, which the store check limits to one literal OpenRouter API key. The session starts in an empty `/qa/out` and is the only session of its environment, so no extension loads. A Pi or adapter version that adds an MCP source means finding and blocking it first.
- The runner container holds no source, no Docker socket, and no credential beyond its login's `auth.json`. Egress goes only through the proxy allowlist in `src/pi.ts`.
- Target services reach outside hosts only through `qa-relay`, and only the target's `egress` hosts. The runner and the target never share a proxy: the runner does not join `qa_relay`, and target services join neither `qa_agent` nor `qa_egress`.
- Every environment's `/qa/out` is its own 1 GiB ext4 disk. The disk helper in `src/environment.ts` is the only privileged container that QA Interns adds to a run. It runs the runner image with fixed scripts from that file on paths the orchestrator chose.
- A value that `secrets` names joins the process-wide set in `src/secrets.ts` where it is read, before any step that can fail, and the set is cleared when the run ends. The API key of the login joins the set before an environment with it starts. A test that adds values without a run clears them. Text from a target or an agent passes through `redact` before it is trimmed or cut to a length, and the transcript redacts across the agent's streamed text chunks as it records them. Every write of `state.json`, `report.md`, and `findings.json`, and every intern progress or error line that `run` prints, is redacted, and the end of a run with a clean teardown redacts every file under `envs/` and `interns/`. A new output outside `envs/` and `interns/` is redacted too.
- Docker objects of a run are named `qa-<runId>-*` and prebuilt images `qa-<runId>-<service in lowercase>:latest`. Manual and test work uses other prefixes and removes what it creates.
- Adapter and browser versions are pinned in `runner/Dockerfile`. A version bump re-verifies the MCP sources of the adapter and of the Pi version it pins from their source before it lands.
