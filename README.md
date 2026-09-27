# QA Interns

QA Interns runs many AI QA interns against a web application at once. Each intern gets its own copy of the application and its backing services, uses the application through a real browser and HTTP, and tries to break it. An intern reports what breaks and the exact conditions under which it breaks. An intern never fixes code, suggests a fix, ranks severity, or guesses a cause.

The design and its scope are in [issue #1](https://github.com/anaclumos/qa-interns/issues/1).

## Requirements

- Linux on x86-64. Chrome for Testing has no Linux ARM64 build.
- Docker Engine with Compose v2 and the `isolated` bridge gateway mode. `qa-interns doctor` checks both.
- Bun 1.4 or later, and Git.
- At least one agent login: Claude Code, Codex, or Cursor (see [Logins](#logins)).
- Memory for the environments you run at once. An environment reserves 2 GiB for its runner, 128 MiB for its proxy, and each service's `mem_limit` (1 GiB when the service sets none).

## Install

As a Claude Code plugin:

```
/plugin marketplace add anaclumos/qa-interns
/plugin install qa-interns@qa-interns
```

Then run `/qa-interns <target-dir> --interns 4`. The skill starts the run in the background, prints the run directory, and reads the report when the run ends. The run stops if the Claude Code session ends.

As a command:

```
git clone https://github.com/anaclumos/qa-interns
cd qa-interns
bun install
bun link
qa-interns doctor
```

## Commands

| Command | What it does |
| --- | --- |
| `qa-interns doctor [--logins <file>]` | Checks Docker, Compose, the isolated network mode, the Dev Container CLI, the runner image and its agents, and the logins. Builds the runner image when it is missing. |
| `qa-interns run <target-dir> [--commit <rev>] [--interns <n>] [--minutes <n>] [--confirm-minutes <n>] [--logins <file>]` | Runs interns against the target at the commit (default `HEAD`, 4 interns, 30 minutes each, 10 minutes per confirmation). Prints the run directory first. |
| `qa-interns status [<run>]` | Prints the phase and every intern's status. |
| `qa-interns report [<run>]` | Prints `report.md`. |
| `qa-interns down [<run>]` | Stops the run's orchestrator with SIGTERM when that process, matched by its pid and start time, is still running. Then tears down every environment the run still has and deletes the run's leftover workspace copies with a container of the current runner image. When copies are left and that image does not exist, it fails; build the image with `qa-interns doctor` and run `down` again. |

`<run>` is a run id or a run directory. Without it, the command uses the most recent run.

## Target environment contract

The target describes its environment with a Compose-based `.devcontainer/devcontainer.json` and puts QA Interns settings under `customizations["qa-interns"]`:

```jsonc
{
  "dockerComposeFile": ["compose.yml"],
  "service": "web",
  "customizations": {
    "qa-interns": {
      "urls": { "app": "http://web:3000" },
      "ready": "http://web:3000/health",
      "seed": "bun run src/seed.ts",
      "focus": ["How invoices calculate and show money."],
      "offLimits": ["Do not change the password of a seeded account."]
    }
  }
}
```

- `urls`: named application URLs as seen from inside the environment network.
- `ready`: an `http:` or `https:` URL that answers 2xx when the application is ready, or a shell command that exits 0 in the dev container.
- `seed`: a shell command, run once in the dev container, that creates test accounts and data and prints them as one JSON document.
- `focus` (optional): areas the project wants covered, added to the charter deck.
- `offLimits` (optional): actions interns must not take.

`run` rejects a target whose Compose files have any of these, because each collides across copies or gives the application the interns attack access to the host:

- A `dockerComposeFile` entry outside the target directory, so the tested services always come from the commit.
- A `container_name`.
- An external volume or network, or a volume or network with an explicit `name:`.
- A `network_mode` other than `service:<name>`, including `host`.
- A service named `qa-proxy` or `qa-runner`.
- A network alias that is the name of another service, `qa-proxy`, or `qa-runner`, or that two services declare.
- Two services whose names differ only in case, since Docker's network names are case-insensitive and prebuilt image tags are lowercase.
- `privileged: true`, `pid: host`, `ipc: host`, or `userns_mode: host`.
- A `devices` entry, a `cap_add` entry, or a `security_opt` entry that contains `unconfined`.
- A bind mount whose source lies outside the target directory. A source that exists is checked after its symbolic links are resolved, so a Docker socket is rejected whether it is mounted directly or through a symbolic link.

Published ports are allowed; QA Interns removes them.

The environment runs on test credentials only: sandbox payment keys, a local mail catcher, no production endpoint. The target project owns that guarantee.

QA Interns runs the target's lifecycle commands, including `initializeCommand`, which runs on the host. Run it only against repositories you trust.

## Logins

`~/.config/qa-interns/logins.json` (or `--logins <file>`) lists the logins interns run on:

```json
{
  "logins": [
    { "id": "claude-1", "provider": "claude", "store": "/home/you/.qa-interns/claude-1" },
    { "id": "codex-1", "provider": "codex", "store": "/home/you/.qa-interns/codex-1" },
    { "id": "codex-pool", "provider": "codex", "seat": ["sh", "-c", "exec tokenmaxxing seat --codex \"$QA_INTERNS_LEASE_PID\""], "concurrency": 2 }
  ]
}
```

A login is a `store` directory or a `seat` command, with a `concurrency` limit (default 1).

| Provider | Store | How to fill it |
| --- | --- | --- |
| `claude` | A directory with `.credentials.json`. Only `.credentials.json` is mounted into the runner. | `CLAUDE_CONFIG_DIR=<store> claude /login` |
| `codex` | A directory with `auth.json`. Only `auth.json` is mounted into the runner. | `CODEX_HOME=<store> codex login` |
| `cursor` | A Cursor credential directory with `auth.json`, mounted whole as `$XDG_CONFIG_HOME/cursor`. Use a directory that only QA Interns uses. | `XDG_CONFIG_HOME=<parent of store> agent login`, with the store named `cursor` |

- Each running intern holds one lease on one login. A Codex store has `concurrency` 1, because OpenAI states that one `auth.json` copy serves one machine or one serialized job stream ([Codex CI/CD auth](https://learn.chatgpt.com/docs/auth/ci-cd-auth)).
- A seat command is an external program that hands out a store for one intern. It runs with `QA_INTERNS_INTERN` and `QA_INTERNS_LEASE_PID` in its environment and prints an absolute store path as its last line. `QA_INTERNS_LEASE_PID` is a process that lives exactly as long as the intern holds the store, and ends when the orchestrator ends, so a pool manager can hold the store until that process exits. A nonzero exit means the seat command has no store now.
- When an agent reports a usage limit or a failed login, the intern moves to another login with spare capacity and restarts its charter. Claude reports a usage limit as JSON-RPC error `-32603` with `data.errorKind` `rate_limit` or `billing_error`, and Codex as `-32603` with `data.codexErrorInfo` `usageLimitExceeded`. Cursor ends the turn with a chat message instead of an error, so a Cursor intern at its limit stops early and the report quotes its last message.

## What a run does

1. Exports the target at the commit and checks its dev container and Compose files.
2. Builds the target's images once.
3. Starts one environment per intern, each as its own Compose project on its own isolated network, at most as many at once as free memory and login capacity allow, and at most four starting at a time.
4. Starts one agent per intern inside that intern's runner container, over the Agent Client Protocol.
5. Gives each intern the rules, one charter, the application URLs, and the seeded accounts. The intern tests until its time box ends and writes each finding as JSON.
6. Groups duplicate findings in one judge pass, then hands each group to a different intern in a fresh environment, on a different provider when one is free, which reproduces it from the written finding alone.
7. Writes the report and tears down every environment, on success, on failure, and on interrupt.

## Run directory and report

Runs live in `~/.local/state/qa-interns/runs/<run-id>/` (`$XDG_STATE_HOME` when set):

- `report.md`: confirmed findings first, then findings seen once, then finding files that failed validation, then the interns.
- `findings.json`: the same data as JSON.
- `interns/<id>/out/`: each intern's findings and evidence (screenshots, recordings, HAR files, console logs).
- `interns/<id>/transcript.jsonl`: the agent traffic of each intern.
- `state.json`: the run's phase and every intern's status.

A finding is confirmed when two or more interns reproduced it.

## Isolation

- Every environment is its own Compose project with three networks in its own `/23` block of `10.213.0.0/16`. The target services and the runner share one internal network, and the runner and the proxy share a second internal network. Only the proxy joins the third network, which reaches the internet. The internal networks have no gateway address, so containers on them reach neither the host nor other environments.
- The runner container holds the agents, agent-browser with Chrome for Testing, ffmpeg, and curl. It has no source mount, no Docker socket, a read-only root file system, and no capabilities. It can write only to `/qa/out`, `/tmp`, and its home directory, and holds no credential beyond its own login. It can also write the login credential file it was given, and that write reaches the store on the host.
- `/qa/out` is the intern's `interns/<id>/out` directory on the host. The runner cannot write a file larger than 1 GiB anywhere. While the agent runs, the orchestrator walks `/qa/out` once a second and stops the runner when it holds more than 1 GiB. The intern then ends as failed, and the findings it wrote stay in the report.
- The runner reaches the internet only through a proxy container that allows HTTPS to the model provider hosts and nothing else.
- Target services have no internet access and cannot reach the proxy. Lifecycle commands that run in a target container, and application code, fail when they need the network.
- Every agent session starts with no MCP servers. Claude and Codex have their MCP sources blocked in `src/providers.ts`. A Cursor runner has no MCP source, because its home directory is an empty tmpfs and the Cursor store holds credentials only.
- Chrome runs with `--no-sandbox`, because Docker's default seccomp profile blocks its sandbox, so the container is the boundary. A compromised renderer can read what the runner user can read, including that intern's login.

## Known limits

- Single-container dev containers are not supported yet.
- The runner image is x86-64 only.
- Two runs started at the same moment can pick the same subnet; the second fails to start that environment.
- A Cursor usage limit ends the intern early instead of moving it to another login.
- The 1 GiB total of `/qa/out` comes from a directory walk, not a quota. A runner can write past it in files of up to 1 GiB each: before the next walk finishes, after the agent's session ends, and in files it deletes while they are still open ([#22](https://github.com/anaclumos/qa-interns/issues/22)).

## Evaluation target

`eval/ledger` is an invoicing application with ten planted defects, listed in `eval/defects.json`. Run QA Interns against it to measure how many defects a run finds:

```
qa-interns run eval/ledger --interns 4
bun eval/score.ts <run>
```
