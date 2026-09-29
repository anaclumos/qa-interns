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
- `claude plugin validate .` and `claude plugin validate skills` pass after any change to `.claude-plugin/` or `skills/`.
- The lefthook `pre-push` hook in `lefthook.yml` runs the install, typecheck, plugin validate, and test commands of the `ci.yml` `test` job, after it checks for a clean tree and a running Docker daemon. `bun install` installs the hook. A change to one of those commands in one file makes the same change in the other. A job that runs git in another repository first runs `unset $(git rev-parse --local-env-vars)`: git exports `GIT_DIR` to hooks, and without the unset the test fixtures commit into this repository and set its `core.bare`.

## Invariants

- An intern never fixes, suggests, ranks, or explains. Prompts, the report, and the finding format carry no field or instruction for any of those.
- No MCP anywhere. Every `session/new` sends `mcpServers: []`. Claude and Codex have their MCP sources blocked in `src/providers.ts`, Grok has them blocked by the root-owned `/etc/grok/requirements.toml` that `runner/Dockerfile` writes, and a Cursor runner has no MCP source because its home is an empty tmpfs and `CURSOR_CONFIG_DIR` points Cursor's settings and sessions into that home, out of the store. Adding a provider means finding and blocking its MCP sources first.
- The runner container holds no source, no Docker socket, and no credential beyond its own login store. Egress goes only through the proxy allowlist in `src/providers.ts`.
- Target services reach outside hosts only through `qa-relay`, and only the target's `egress` hosts. The runner and the target never share a proxy: the runner does not join `qa_relay`, and target services join neither `qa_agent` nor `qa_egress`.
- Every attempt's `/qa/out` is its own 1 GiB ext4 disk. The disk helper in `src/environment.ts` is the only privileged container that QA Interns adds to a run. It runs the runner image with fixed scripts from that file on paths the orchestrator chose.
- Usage-limit detection is structural: JSON-RPC `code` and `data` fields only, never message text.
- A Codex `auth.json` serves one running process at a time.
- Docker objects of a run are named `qa-<runId>-*` and prebuilt images `qa-<runId>-<service in lowercase>:latest`. Manual and test work uses other prefixes and removes what it creates.
- Adapter and browser versions are pinned in `runner/Dockerfile`. A version bump re-verifies the adapter's usage-limit error shape and MCP sources from its source before it lands.
