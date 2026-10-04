# QA Interns

QA Interns runs many AI QA interns against a web application at once. Each intern gets its own copy of the application and its backing services, uses the application through a real browser and HTTP, and tries to break it. An intern reports what breaks and the exact conditions under which it breaks. An intern never fixes code, suggests a fix, ranks severity, or guesses a cause.

The design and its scope are in [issue #1](https://github.com/anaclumos/qa-interns/issues/1).

## Requirements

- Linux 5.19 or later on x86-64, with cgroup v2. Chrome for Testing has no Linux ARM64 build. QA Interns reads the peak memory of each container from the `memory.peak` file of its cgroup, which older kernels and cgroup v1 do not have. `qa-interns doctor` checks that it can read that file.
- Docker Engine with Compose 5.0 or later, the `isolated` bridge gateway mode, and privileged containers that can use loop devices. QA Interns mounts each intern's output disk from such a container, so the state directory must be on a mount with shared propagation, which is the systemd default. `qa-interns doctor` checks all of these. Compose 2 drops `env_file` paths from `docker compose config --no-env-resolution`, which the target checks read.
- Bun 1.4 or later, Git, and `flock` and `findmnt` from util-linux.
- `XDG_RUNTIME_DIR` set to a directory that only you can use, as a systemd login session sets it. QA Interns keeps the locks of its network blocks there.
- At least one agent login: Claude Code, Codex, Cursor, Grok, or OpenCode with an OpenCode Go or OpenRouter API key (see [Logins](#logins)).
- Memory for the environments you run at once. QA Interns does not check free memory before it starts an environment. An environment caps its runner at 4 GiB, its proxy at 128 MiB, its relay at 128 MiB when the target lists `egress` hosts, and each container of a service at the service's `mem_limit`, or 1 GiB when the service sets none. Docker also lets each of these containers use as much swap as its memory cap.

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
| `qa-interns validate <target-dir> [--commit <rev> \| --dirty]` | Checks the target's dev container and Compose files at the commit (default `HEAD`), or with `--dirty` in the same copy of the working tree that `run --dirty` takes, as `run` does before it builds images. Needs no logins, no runner image, and no value for a `hostEnv` variable that no checked setting reads (see [Target environment contract](#target-environment-contract)). |
| `qa-interns run <target-dir> [--commit <rev> \| --dirty] [--interns <n>] [--minutes <n>] [--confirm-minutes <n>] [--logins <file>] [--on-end <command>]` | Runs interns against the target at the commit (default `HEAD`, 4 interns, 30 minutes each, 10 minutes per confirmation). With `--dirty`, runs them against a copy of the target's working tree, taken when the run starts: the tracked files that the working tree holds, as they are, and the untracked files that Git does not ignore. `state.json` and the `environment` of each finding record the commit of `HEAD` with `dirty: true`, and `report.md` names the uncommitted changes after the commit. Prints the run directory first. With `--on-end`, runs the command when the run ends (see [Command when a run ends](#command-when-a-run-ends)). |
| `qa-interns replay <run> [--commit <rev>] [--group <id>]... [--confirm-minutes <n>] [--logins <file>]` | Hands each confirmed group of the earlier run to a confirming intern against that run's target at the commit (default `HEAD`, 10 minutes per confirmation). See [Replay](#replay). Prints the run directory first. |
| `qa-interns up <target-dir> [--commit <rev>]` | Starts one environment of the target at the commit (default `HEAD`) with no interns, runs its `ready` check and `seed`, and leaves it running. Prints the run directory first, then the Compose project, the IDs of the runner and the dev container, and the seed output. When a step fails, it tears the environment down. `qa-interns down` removes the environment. |
| `qa-interns status [<run>]` | Prints the phase and every intern's status. |
| `qa-interns report [<run>]` | Prints `report.md`. |
| `qa-interns down [<run>]` | Stops the run's orchestrator with SIGTERM when that process, matched by its pid and start time, is still running. Then tears down every environment the run still has, saves the relay log of each of those environments and each output disk the run left into its folder, and deletes the run's leftover workspace copies, with containers of the current runner image. When disks or copies are left and that image does not exist, it fails; build the image with `qa-interns doctor` and run `down` again. |

`<run>` is a run id or a run directory. Without it, the command uses the most recent run.

`up` starts the environment an intern gets, with the same checks, networks, relay, and limits, except that its runner holds no login and has no proxy. The runner reaches the target services and nothing else, so it sees the application as an intern does, for example with `docker exec <runner> curl -sS http://web:3000/health`. The runner's `/qa/out` is an output disk like an intern's, and `down` saves it into `interns/up/out/`.

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
      "offLimits": ["Do not change the password of a seeded account."],
      "egress": ["api.pwnedpasswords.com"],
      "connectionLimits": { "api.pwnedpasswords.com": { "concurrent": 2, "perMinute": 30, "total": 300 } }
    }
  }
}
```

- `urls`: named application URLs as seen from inside the environment network. The interns' browser treats the origin of each `http:` URL as a secure context, so `crypto.subtle`, `crypto.randomUUID()`, and `navigator.clipboard` work as they do over HTTPS. An `http:` origin that `urls` does not name, such as another port on the same host, is not a secure context.
- `ready`: an `http:` or `https:` URL that answers 2xx when the application is ready, or a shell command that exits 0 in the dev container.
- `seed`: a shell command, run once in the dev container, that creates test accounts and data and prints them as one JSON document.
- `focus` (optional): areas the project wants covered, dealt to interns before the built-in charters. A run with no more interns than focus entries deals no built-in charter; list fewer focus entries or raise `--interns` to get both.
- `offLimits` (optional): actions interns must not take.
- `knownGaps` (optional): known gaps of the test environment, such as a feature that has no local stand-in. The testing intern prompt lists them as areas not to report. The confirming intern prompt leaves them out, so a confirmation states only whether a finding reproduces. A finding that an intern writes about a known gap appears in the report like any other finding.
- `hostEnv` (optional): names of variables the target takes from the environment that runs `qa-interns`. `run` fails when one of them is not set, and `validate` sets such a variable to a placeholder.
- `secrets` (optional): values that QA Interns replaces with `[redacted]` in the run directory (see [Run directory and report](#run-directory-and-report)). `secrets.hostEnv` lists names from `hostEnv` whose values are secret, such as an API key. `secrets.seed` lists names of fields in the seed output whose values are secret, such as a seeded API key, and every string under a field with one of these names, at any depth, is secret. A secret value needs at least 8 characters that are not control characters, because removing a shorter value also changes unrelated text, and an empty value is skipped. `run` fails when `secrets.hostEnv` names a variable that `hostEnv` does not name or whose value is shorter. An environment fails when its seed output has no field that `secrets.seed` names, or has a shorter string under one. Interns still get the seed output unchanged.
- `egress` (optional): outside hosts that the target services reach over TLS on port 443, such as HTTPS, for a service that has no local stand-in, such as a hosted model API. Each entry is an exact lowercase host name; a wildcard or an IP address is rejected. When such a host needs a credential, a target service takes it from a variable that `hostEnv` names.
- `connectionLimits` (optional): limits on the TLS connections that target services open to an `egress` host, keyed by that host. `concurrent` is the most connections open at once, `perMinute` the most connections opened in any 60 seconds, and `total` the most connections opened in one environment. Each limit is a whole number of at least 1, and a host sets at least one of them. The limits count the connections of each environment on its own, lifecycle commands and the seed included. A run starts one environment per testing intern, one per confirmation, and one more for each move to another login. It runs at most `--interns` of them at once while interns test, and at most as many as there are groups of findings while interns confirm. The relay refuses a connection past a limit by closing it, so the application sees a closed connection, and the [Egress connections](#run-directory-and-report) section of the report counts it with the outcome `refused`. One TLS connection carries any number of HTTP requests, one after another or, over HTTP/2, at once, so these limits do not limit HTTP requests.

`run` rejects a target whose Compose files have any of these, because each collides across copies or gives the application the interns attack access to the host:

- A `dockerComposeFile` entry outside the target directory, so the tested services always come from the run's copy of the target.
- An `include` path, `project_directory`, or `env_file`, or an `extends.file`, that is not an existing path inside the target directory. These paths are checked as written: a path that contains `$` or `:`, or starts with `~` or `github.com/`, is rejected, because Compose may expand it or load it from a remote source. The `.env` file that Compose reads from an included project's directory must also resolve inside the target. An `include` inside an included file cannot set a relative `project_directory` or `env_file`, because Compose resolves those against the directory it runs in.
- A `container_name`.
- An external volume or network, or a volume or network with an explicit `name:`.
- A volume with `driver_opts` or a `driver` other than `local`.
- A `network_mode` other than `service:<name>`, including `host`.
- A service named `qa-proxy`, `qa-relay`, or `qa-runner`, in any letter case.
- A network alias that is the name of another service, `qa-proxy`, `qa-relay`, or `qa-runner`, or that two services declare.
- An `egress` host that is the name or a network alias of a service.
- Two services whose names differ only in case, since Docker's network names are case-insensitive and prebuilt image tags are lowercase.
- `privileged: true`, or a `pre_start`, `post_start`, or `pre_stop` hook with `privileged: true`.
- A `pid`, `ipc`, `uts`, `cgroup`, or `userns_mode` of `host` or `container:<name>`.
- A `devices` entry, a `device_cgroup_rules` entry, `gpus`, a device reservation under `deploy.resources.reservations`, a `runtime` other than `runc` (the NVIDIA runtime, for example, can add host GPUs), a `cap_add` entry, or a `security_opt` entry other than `no-new-privileges`. A seccomp or AppArmor profile, a label option, or `unconfined` can each loosen the default confinement.
- `use_api_socket: true`, which mounts the Docker socket.
- A `volumes_from` entry with a `container:` source.
- A build with a `network` other than `default` or `none`, `privileged: true`, an `entitlements` entry, an `ssh` entry, a `cache_to` entry, or a `cache_from` entry other than an image reference.
- A bind mount, `env_file`, secret or config `file`, build context, Dockerfile, additional build context, or project `.env` file (the `.env` beside the first Compose file, which Compose reads for interpolation) whose path lies outside the target directory, and an additional build context from an `oci-layout://` directory. A path is checked after its symbolic links are resolved, so a Docker socket is rejected whether it is mounted directly or through a symbolic link, and so is a missing path under a symbolic link that points outside the target.

`devcontainer up` writes settings from `devcontainer.json`, its features, and the `devcontainer.metadata` label of the dev container image into its own Compose files. After `devcontainer up` creates an environment's dev container, `run` renders the environment's Compose files with and without the files the Dev Container CLI wrote. Those files may add volumes and may change only the `image`, `build`, `entrypoint`, `command`, `init`, `user`, `environment`, `labels`, `privileged`, `cap_add`, `security_opt`, and `volumes` of the dev container service. `run` then applies the checks above, except the build checks, to every target service in the environment's copy of the target, with the environment variables `devcontainer up` used. When a check fails, the environment is torn down before its intern starts.

`qa-interns validate` exports the target at the commit, or with `--dirty` copies its working tree, as `run` does, and makes the checks that `run` makes before it builds images. It does not make the checks after `devcontainer up`, which need a started environment. It uses the host value of each `hostEnv` variable that the host sets. When a `hostEnv` variable is not set, `validate` sets it to `/qa-interns-unset/<name>` for the checks. It also renders the Compose files with `/qa-interns-unset/<name>/<name>` and fails when a setting that the checks read differs between the two renders, such as a bind mount source built from the variable. A variable that only a service's `environment` reads, such as an API key, needs no value. Set a variable that a checked setting reads to the value `run` uses.

Published ports and build `tags` are allowed; QA Interns removes them. `logging` settings are allowed; QA Interns replaces them with its own log limit (see [Isolation](#isolation)).

A service without `build` whose `image` names the `image` or a build `tags` entry of a service with `build` that the run starts runs the image QA Interns builds for that service, as it does in the target's own dev container. Names match as Docker resolves them, so `app` and `docker.io/library/app:latest` name the same image.

A restart policy applies only while an environment starts. Before the intern starts, QA Interns sets the restart policy of every container in the environment to `no`, so a service that stops while the intern tests stays stopped. Docker resolves the source of a bind mount each time it starts a container, and a service that writes to the directory that holds a bind source can replace that source with a symbolic link to a host path, which the next start would mount.

The environment runs on test credentials only: sandbox payment keys, a local mail catcher, no production endpoint beyond the `egress` hosts. The target project owns that guarantee.

Compose and the Dev Container CLI run with the variables that `hostEnv` names and the ones they need to reach Docker: `PATH`, `HOME`, `DOCKER_HOST`, `DOCKER_CONTEXT`, `DOCKER_CONFIG`, `DOCKER_CERT_PATH`, `DOCKER_TLS`, `DOCKER_TLS_VERIFY`, and `DOCKER_API_VERSION`. QA Interns removes every other variable of its own environment before it runs them. Compose interpolation, an `environment` entry without a value, `${localEnv:...}` in `devcontainer.json`, and `initializeCommand` read from what remains. `DOCKER_CONFIG` names a copy of the Docker client configuration without its `proxies` setting, in a directory outside the target, because Compose sets those proxies on every container it creates and passes them as build arguments to every image build.

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

A login is a `store` directory or a `seat` command, with a `concurrency` limit (default 1) and an optional `model`. Without `model`, an intern runs on the agent's default model. With `model`, QA Interns sets the session's `model` config option to that value with `session/set_config_option` after it opens each session, and a value the agent does not offer fails the intern with the agent's error. The values are the agent's own, such as `grok-4.7` for Grok, and `opencode-go/glm-5.3-flash` or `openrouter/xiaomi/mimo-v2.6-pro` for OpenCode. QA Interns asks Cursor for its parameterized model picker, so a Cursor `model` is a model name with optional parameter values in brackets, in Cursor's own format, such as `grok-4.7[context=256k,reasoning_effort=high,fast=false]`. QA Interns sets the `model` config option to the name, then sets each `name=value` in the brackets as a config option of its own. A parameter that the value leaves out keeps Cursor's default for the model.

QA Interns leases logins in the order the file lists them. An intern gets the first login that is not exhausted for the run and has spare concurrency. It gets a later login only when every earlier login is exhausted, is at its concurrency limit, or has a seat command that lends no store. A confirming intern and the judge take a login the same way, even when the confirming intern's login has the provider that wrote the finding.

A login can also set `quota`, a command given as an argument list, like `seat`. QA Interns runs it before each lease of the login, and when the agent of a testing intern on the login stops on its own. Exit 0 means the login has quota left, and exit 1 means it has none. Exit 1 before a lease exhausts the login for the run, and the intern takes the next login. Exit 1 after the agent stops counts as a usage limit, as below. Any other exit, or no exit within 60 seconds, fails the intern with the command's exit code and standard error.

| Provider | Store | How to fill it |
| --- | --- | --- |
| `claude` | A directory with `.credentials.json`, mounted whole as the runner's credential store (`CLAUDE_SECURESTORAGE_CONFIG_DIR`), so the runner takes the same token refresh lock as every other Claude Code process that keeps its credentials there. A runner writes only `.credentials.json` and its lock and temporary files there. Never start Claude Code with the store as `CLAUDE_CONFIG_DIR`, because a runner can write settings and hooks into the store. QA Interns rejects a store that is or contains `~/.claude` or `$CLAUDE_CONFIG_DIR`. | `CLAUDE_CONFIG_DIR="$(mktemp -d)" CLAUDE_SECURESTORAGE_CONFIG_DIR=<store> claude /login` |
| `codex` | A directory with `auth.json`. Only `auth.json` is mounted into the runner. | `CODEX_HOME=<store> codex login` |
| `cursor` | A Cursor credential directory with `auth.json`, mounted whole as `$XDG_CONFIG_HOME/cursor`. Use a directory that only QA Interns uses. | `XDG_CONFIG_HOME=<parent of store> cursor-agent login`, with the store named `cursor` |
| `grok` | A directory with `auth.json`, mounted whole, because Grok replaces the file when it refreshes the token. A runner writes only `auth.json` and its lock file there. Use a directory that only QA Interns uses. | `GROK_HOME=<store> grok login` |
| `opencode` | A directory with `auth.json`, an OpenCode auth file that holds one API key, for the `opencode-go` provider (OpenCode Go) or the `openrouter` provider (OpenRouter), and nothing else. The key needs at least 8 characters, as a `secrets` value does, because QA Interns redacts it from the run directory. QA Interns rejects any other content, because a runner can read every credential in the file, and OpenCode loads remote configuration for a `wellknown` entry. Only `auth.json` is mounted into the runner, read-only. OpenCode runs with only the provider of that key enabled, so every model request uses that key, and the runner's proxy allows only that provider's host: `opencode.ai` for `opencode-go` and `openrouter.ai` for `openrouter`. OpenCode also runs without its `title` agent, which would otherwise send each session's first message in an extra request that names the session, to a smaller model of the same provider when OpenCode finds one. | `XDG_DATA_HOME=<parent of store> opencode auth login --provider opencode-go`, or `--provider openrouter`, with the store named `opencode` |

- Each running intern holds one lease on one login. Interns that share a Codex store share its one `auth.json`, which risks the refresh race that [Known limits](#known-limits) describes. The lease ends once the teardown has removed the containers and networks of the intern's environment, before the rest of the teardown.
- A lease locks the real path of what the runner mounts until the lease ends: the credential file of a Codex or OpenCode store, and the whole store of a Claude, Cursor, or Grok store. When a lease starts, QA Interns checks under the lock that what the runner mounts is still the path the lease locked and has no symbolic link on it. The intern fails when the store changed since it was checked, such as when another runner replaced a directory on its path with a symbolic link. The locks live in `~/.local/state/qa-interns/locks/` (`$XDG_STATE_HOME` when set). Runs that share that directory hold, all together, no more leases on one credential than the highest `concurrency` any of them sets for it. They also never hold two leases at once when the mounted path of one contains the mounted path of the other, such as a Cursor store and a Codex store inside it, or when the two leases have different providers and one mounted path, such as a Codex and an OpenCode lease on one `auth.json`.
- QA Interns rejects a store whose path resolves through a symbolic link, and a store whose credential file is a symbolic link. Name each store by its real path. A Claude, Cursor, or Grok runner can place a link in its store, so a link in the path of a store inside it, or in place of that store's credential file, could choose the host path that a runner of another run mounts. A Claude, Cursor, or Grok runner also mounts only the store, so a linked credential file resolves against the runner's file system, not the host's.
- A seat command is an external program that hands out a store for one intern. It runs with `QA_INTERNS_INTERN` and `QA_INTERNS_LEASE_PID` in its environment and prints an absolute store path as its last line. `QA_INTERNS_LEASE_PID` is a process that lives exactly as long as the intern holds the store, and ends when the orchestrator ends, so a pool manager can hold the store until that process exits. A nonzero exit means the seat command has no store now. The printed store is checked like a configured store, against every configured store and every store an intern holds, and a store that fails a check counts as no store. The one exception is a store that interns of the same login already hold in the run: the login's seat command can lend it to more interns, up to the login's `concurrency`, as a configured store serves them. Across runs, only the locks above limit such a store, whatever login holds it. When an intern ends as `limited`, its detail names each printed store that failed a check in its last search for a login, with the login and each failed check. A last line that is not an absolute path is named as such and not repeated.
- An intern that gets no lease waits while a run that shares the locks directory, its own or another, holds or is acquiring a lease that keeps it from a login it can still use. The intern can still use a seat login, and a store login that has not reported a usage limit or a failed login in its run, when the `quota` command of the login has not exited 1 in its run. For a store login, these are the leases that its lock conflicts with. For a seat login, these are the leases and the running seat commands of runs that name the same seat command. The waiting intern asks again each time a run that shares the locks directory releases a lease, and every 30 seconds, which also covers a lease whose process ended without releasing it. When no such lease is held or being acquired, the intern ends as `limited`, as it does when a seat command has no store and no run holds a store from that seat command.
- When an agent reports a usage limit or a failed login, QA Interns stops leasing that login for the run, or only the store it lent when it is a seat login. When the `quota` command of its login exits 1 after the agent of a testing intern stops on its own, QA Interns stops leasing that login for the run. In both cases the intern moves to the next login with spare capacity and restarts its charter in a fresh environment with an empty `/qa/out`. While it waits for that login, the intern has the status `queued`, and its detail names the earlier login with the error or the `quota` command result. The findings of the earlier attempt stay in the report, and `findings.json` records the provider and model of the attempt that wrote each one. A confirming intern that moves answers with the `confirmation.json` of its latest attempt that wrote a valid one, under that attempt's provider. Claude reports a usage limit as JSON-RPC error `-32603` with `data.errorKind` `rate_limit` or `billing_error`, and Codex as `-32603` with `data.codexErrorInfo` `usageLimitExceeded`. Grok reports a rate or usage limit as `-32003`, and spent credits or a rejected token as `-32603` with `data.http_status` 402 or 401. Cursor ends the turn with a chat message instead of an error, so a Cursor intern at its limit stops early and the report quotes its last message. It moves to the next login only when its login has a `quota` command that exits 1. OpenCode reports a rejected key, a spent balance, and every other failed request to OpenCode Go or OpenRouter with one shape, `-32603` with `data.errorName` `APIError`, so an OpenCode intern does not move on an error. A testing intern whose agent stops before its first tool call in an attempt ends as `failed`, unless the `quota` command of its login exits 1. A testing intern that makes no tool call before the attempt's time box ends also ends as `failed`. A run in which no testing intern ends as `done` fails.

## What a run does

1. Exports the target at the commit, or copies its working tree with `--dirty`, and checks its dev container and Compose files.
2. Builds the target's images once.
3. Starts one environment per intern, each as its own Compose project on its own isolated network, at most as many at once as login capacity and free network slots allow. An environment stops counting once its containers and networks are removed, so the next intern starts while the rest of its teardown runs. Checks each dev container that `devcontainer up` created.
4. Starts one agent per intern inside that intern's runner container, over the Agent Client Protocol.
5. Gives each intern the rules, one charter, the application URLs, and the seeded accounts. The intern tests until its time box ends and writes each finding as JSON.
6. Groups duplicate findings in one judge pass, then hands each group to a different intern in a fresh environment, which reproduces it from the written finding alone. That intern follows the finding's steps, then does the same task again through the controls the page offers for it, and records both results. The second time, it uses the control the page shows for each purpose a step names, and keeps every action, value, and condition that the finding names as part of the failure, such as a repeated click or a second tab. When the steps are the only way to do the task, such as a request sent directly or another account's ID in a URL, the steps are the task, and both results are the same. When the intern's time box ends before it writes `confirmation.json`, QA Interns stops its turn. When that turn ends within 60 seconds, QA Interns gives the intern one more turn, of at most 2 minutes, to write the file from the attempts it made. In that file, a result is true when one of those attempts showed the failure, and false only when the intern made both attempts and neither showed it. An intern that cannot give both results that way writes no file, and its confirmation records no result. The confirmations of all groups run at once, as far as the login capacity and free network slots that the run found when it started allow, so this phase can run more interns at once than `--interns`.
7. Writes the report and tears down every environment, on success, on failure, and on interrupt.

## Run directory and report

Runs live in `~/.local/state/qa-interns/runs/<run-id>/` (`$XDG_STATE_HOME` when set):

- `report.md`: confirmed findings first, then findings that were not confirmed, then finding files that failed validation, then the interns, then the connections that target services opened through the relay, then the environments.
- `findings.json`: the same data as JSON.
- `tickets/<group>/`: a ticket draft for each confirmed group, for a person to review and file on a tracker. QA Interns files nothing. `title.txt` holds the title of the group's first finding. `body.md` holds the run id, the commit, the kind, the reproductions, the conditions, steps, observation, contradiction, and evidence paths of the first finding, the intern and observation of each other finding in the group, and the confirmation. Each text an intern wrote is in a Markdown code block with no escape characters added, so a Markdown renderer shows it as written. The folder holds a hard link to each evidence file that `body.md` lists, at the same path, so the draft takes no extra disk space, a copy of the folder holds the files, and a change to a file in the folder changes the run's evidence file too. An evidence file that is not a regular file at exactly that path, for example because it is missing or its path passes through a symbolic link, is not linked, and `body.md` ends with a list of those files and the reason for each.
- `interns/<id>/out/`: each intern's findings and evidence (screenshots, recordings, HAR files, console logs). After a move to another login, the next attempt writes to `interns/<id>/out-2/`, the one after it to `out-3/`, and so on. The id of a finding from such an attempt names its folder, as in `i1/out-2/<slug>`.
- `interns/<id>/transcript.jsonl`: the agent traffic of each intern.
- `interns/<id>/adapter.log`: the error output of each intern's agent.
- Each transcript and error log stops growing at 64 MiB. Later traffic and output are not recorded.
- `interns/<id>/relay-<container>.jsonl`: the log of the relay container of one of the intern's environments, saved after the environment's containers stop and before they are removed. It has one JSON line for each connection that a target service opened through that relay, with `n`, the line's position in the relay's log, and `host`, `outcome`, and `error`.
- `state.json`: the run's phase and every intern's status. `options.concurrency` and `options.confirmConcurrency` hold the most interns that the testing phase and the confirming phase run at once.

A finding is confirmed when two or more interns reproduced it, unless its confirmation shows the failure with the steps but not with the task through the page's own controls. A confirming intern reproduced it when both of its results show the failure. The report names both results.

`state.json`, `report.md`, `findings.json`, and the lines `run` prints have every value that `secrets` names replaced with `[redacted]` as they are written. The API key of an OpenCode login counts as such a value from the moment QA Interns starts an environment with that login, because the agent can read the key in its `auth.json`. An error or message that quotes part of a command's output, or of an agent's message, has the values replaced before the cut, so no part of a value is left at the cut. A transcript records an agent's streamed text with each value replaced, also when the agent's chunks split it, with other session updates between them. To do that, it holds the last text chunks and the records after them, up to 64 MiB, until enough text follows or a message that is not a session update arrives. When the run ends and its teardown succeeds, QA Interns replaces the values the same way in every file under `envs/` and `interns/`: the environment logs, the transcripts, the error logs, and each intern's findings and evidence. It replaces each value as written, in its JSON string escaping applied once or twice, which covers the seed output inside a prompt in a transcript, and without its control characters, as the report and `state.json` store text. Where two values overlap, every character of both is replaced. A value in any other form stays, such as URL encoding, HTML escaping, base64, compressed data, or the pixels of a screenshot or a recording, and so does a value in a file name.

The report has one entry for each environment that an intern, the judge, or a confirmation started, including each attempt after a move to another login. An entry has the time QA Interns began to create the environment and the time its ready check passed, which is empty when the check never passed. An environment without a target, such as the judge's, is ready when its containers run. For each container of the environment, QA Interns reads at teardown:

- The container's state.
- Its peak memory, which is the `memory.peak` value of its cgroup, in bytes in `findings.json`. It counts page cache, as `mem_limit` does. A container that stopped before teardown has no peak memory.
- Whether the kernel killed a process in the container for lack of memory, whichever process that was.
- How many times its restart policy restarted it.

A restart resets the peak memory and the out-of-memory flag. For a container that restarted while its environment started, both cover only the time since its last restart.

The **Egress connections** section of `report.md` and the `egress` list of `findings.json` count the relayed connections of the whole run, with one row for each host, outcome, and error, and the interns whose environments opened them. An `egress` host that no target service connected to has a row with no outcome and 0 connections. The relay passes TLS through unchanged, so it counts connections, not HTTP requests, and one connection can carry many requests. The relay records a connection when its outcome is known, with one of these outcomes:

- `connected`: the relay opened a connection to the host on port 443. What happens on the connection after that is not recorded.
- `failed`: the relay did not open a connection to the host. `error` is the Node.js error code of that attempt, such as `ENOTFOUND` or `ECONNREFUSED`, or `timeout` when the relay stopped waiting after 10 seconds. `error` is empty when the target service closed the connection first.
- `denied`: the connection did not start with a TLS handshake that names an `egress` host. `host` is the name the handshake names, cut to its first 253 characters, the longest a DNS name can be, and is empty when the connection did not start with a TLS handshake that names a host.
- `refused`: the handshake named an `egress` host, and the connection would have passed one of the host's `connectionLimits`. `error` is that limit: `total`, `concurrent`, or `perMinute`, checked in that order. The relay closed the connection without opening one to the host.
- `incomplete`: the connection closed before it sent a complete TLS record. `error` is `timeout` when the relay closed it after 10 seconds.
- `unrecorded`: connections whose records Docker dropped from the relay's log (see [Known limits](#known-limits)). They have no host.

## Command when a run ends

`run --on-end <command>` runs `<command>` with `sh -c` on the host when the run ends, whether it is done, failed, or interrupted by SIGINT, SIGTERM, or SIGHUP. The command runs after the teardown and after `report.md`, `findings.json`, and `state.json` are written. It gets the environment of `qa-interns` and these variables:

- `QA_INTERNS_RUN_DIR`: the run directory.
- `QA_INTERNS_PHASE`: `done` when the run is done, and `failed` otherwise, including an interrupt and a failure to write `report.md`, `findings.json`, or `state.json`. The `error` in the `state.json` of an interrupted run starts with `interrupted`.

Quote the command so that the shell that starts `run` does not expand these variables:

```
qa-interns run eval/ledger --on-end 'echo "$QA_INTERNS_PHASE $QA_INTERNS_RUN_DIR" >> "$HOME/qa-runs.log"'
```

The command writes to the standard output and error of `run`. `run` waits for the command to exit, then exits 0 when the run is done, 1 when it failed, and 130 after an interrupt. When the command exits with a code other than 0, `run` prints that code, and a run that is done exits 1. A run that fails before it prints its run directory, such as on a missing logins file, does not run the command.

A signal to `run` while the command runs after a done or failed run, such as the SIGTERM that `qa-interns down` sends, sends SIGTERM to the command, and `run` exits 130. After an interrupt, `run` ignores further signals until it exits, so the wait of up to 120 seconds that `qa-interns down` allows includes the time the command takes.

## Replay

`qa-interns replay <run>` reruns the confirmed findings of an earlier run against a fresh copy of the target, for example at the commit of a change. It resolves `--commit` in the repository that the earlier run tested, then exports, checks, and builds the target at the earlier run's path, as steps 1 and 2 of a run do. It hands the first finding of each confirmed group to a confirming intern in a fresh environment, as step 6 does, and runs no testing intern and no judge. `--group <id>` limits the replay to one confirmed group; repeat it to name more. The replay fails when no intern records a result for any group.

A replay is a run of its own, with its own run directory, and `status`, `report`, and `down` work on it. Its `report.md` lists the groups that the interns reproduced, then the groups that they did not reproduce, then the groups that no intern checked. It ends with the interns, the connections through the relay, and the environments, as the report of a run does. Each group keeps the id it has in the earlier run and shows the finding the intern followed and the intern's confirmation. `findings.json` carries the same data. Each finding in it is as the earlier run recorded it, so its evidence paths are relative to the earlier run's directory. A replay writes no ticket drafts. A replay cannot be replayed; replay the earlier run again.

## Isolation

- Every environment is its own Compose project with its networks in its own `/23` block of the range that the `QA_INTERNS_SUBNET` environment variable sets, `10.213.0.0/16` when it is not set. The range is an IPv4 network address with a prefix length from 16 to 23, such as `10.100.0.0/20`, and holds one environment per `/23` block. A command that starts an environment skips a block that overlaps a Docker network or a host route. It also skips a block that another QA Interns process of the same user holds. A process locks the block it picks with a file in `$XDG_RUNTIME_DIR/qa-interns/slots/` and holds the lock until the teardown has removed the environment's containers and networks, or, for `up`, until the environment has started. The lock ends when the process exits. That command and `doctor` fail when `QA_INTERNS_SUBNET` is set to anything else. The target services and the runner share one internal network, and the runner and the proxy share a second internal network. An environment that `up` starts has no proxy and no second network. When the target lists `egress` hosts, the target services and the relay share a third internal network. Only the proxy and the relay join the network that reaches the internet. The internal networks have no gateway address, so containers on them reach neither the host nor other environments.
- The runner container holds the agents, agent-browser with Chrome for Testing, ffmpeg, curl, and ripgrep. It has no source mount, no Docker socket, a read-only root file system, and no capabilities. It can write only to `/qa/out`, `/tmp`, and its home directory, and holds no credential beyond its own login. It can also write the login credential it was given, which is the credential file for Codex and the whole store directory for Claude, Cursor, and Grok, and that write reaches the store on the host. An OpenCode runner gets its credential file read-only.
- `/qa/out` is a 1 GiB ext4 disk of its own for each attempt, mounted on that attempt's folder under `interns/<id>/`. The kernel stops every write past the disk's size or its inode count, including writes to files deleted while still open and space reserved without writing. A privileged helper container from the runner image, with the host `/dev`, creates and mounts the disk before the environment starts. At teardown, the helper copies the disk into the folder and deletes the disk image. The runner cannot write a file larger than 1 GiB anywhere. While the agent runs, the orchestrator checks the disk once a second and stops the runner when the disk is full. The intern then ends as failed, and the findings it wrote stay in the report.
- The orchestrator keeps an agent's output in memory until a newline arrives. An intern fails when its agent prints more than 64 MiB without a newline, or when the orchestrator's messages to the agent pass 64 MiB in total.
- The runner reaches the internet only through a proxy container that allows HTTPS to the model provider hosts and nothing else.
- Docker keeps the log of every container in an environment, the target services included, with the `local` log driver, whatever log driver and options the Docker daemon or the target's Compose files set. Each log is a current file and the previous file. Docker starts a new current file once the current file holds 10 MB, and then compresses the previous file. A log of data that does not compress takes up to about 20 MB, and up to about 30 MB while that compression runs.
- Target services cannot reach the proxy. They reach the internet only through a relay container, and only the `egress` hosts over TLS on port 443. Each target service resolves those hosts to the relay through its hosts file and starts after the relay accepts connections. The relay reads the host name from the TLS handshake, refuses any other host, any connection that does not start with a TLS handshake, and any connection past a connection limit of its host, and passes the encrypted connection through unchanged, so the application needs no proxy setting and checks the real server's certificate. The relay does not check which protocol runs inside TLS. Lifecycle commands that run in a target container, and application code, fail when they need any other host.
- Every agent session starts with no MCP servers. Claude and Codex have their MCP sources blocked in `src/providers.ts`. Grok has them blocked by the root-owned `/etc/grok/requirements.toml` in the runner image. A Cursor runner has no MCP source, because its home directory is an empty tmpfs and `CURSOR_CONFIG_DIR` keeps Cursor's settings and sessions in that home, out of the store. OpenCode has no setting that turns MCP off. An OpenCode runner starts with no MCP source, because its home directory is an empty tmpfs, its `auth.json` holds only one `opencode-go` or `openrouter` API key, and `OPENCODE_DISABLE_PROJECT_CONFIG` skips project configuration. `OPENCODE_PERMISSION` in `src/providers.ts` denies every tool except the built-in tools an intern uses. That removes the `websearch` tool, which calls an outside MCP server, and the tools of an MCP server added during the session.
- Chrome runs with `--no-sandbox`, because Docker's default seccomp profile blocks its sandbox, so the container is the boundary. A compromised renderer can read what the runner user can read, including that intern's login.

## Known limits

- Single-container dev containers are not supported yet.
- The runner image is x86-64 only.
- The block locks are per user. Runs of two users on one Docker daemon, or of one user with two values of `XDG_RUNTIME_DIR`, can pick the same block at the same moment, and so can a process that creates a Docker network in the range outside QA Interns. The environment that creates its networks second fails to start.
- `validate` sets an unset `hostEnv` variable to a placeholder that is not empty. A checked setting that changes only when the variable is empty, such as one built with `${VAR:+...}`, passes `validate` and can fail `run` when the variable is empty. A variable in a setting that Compose checks against a format, such as a number in `scale`, a boolean in `privileged`, a size in `mem_limit`, or a port in `ports`, fails `validate` with a Compose error that quotes the placeholder. A variable in the container path of a volume needs a value, because `validate` compares volume targets. A `hostEnv` variable that Compose reads as its own setting, such as `COMPOSE_PROFILES`, gets the placeholder too, so `validate` checks the services that the placeholder selects.
- A Cursor usage limit ends the intern early instead of moving it to another login, unless the login has a `quota` command that exits 1 when the agent stops. Without one, a testing intern that reaches the limit after its first tool call ends as `done`.
- A waiting intern has no time limit. It waits as long as other runs hold or acquire leases on the logins it can use.
- An intern waits only for leases that QA Interns runs hold. When a program outside QA Interns holds every store that a seat command can hand out, the intern ends as `limited`.
- Credential locks and the store checks compare real paths, so two hard links to one credential file count as two credentials.
- A Claude, Cursor, or Grok runner can read and change every file in its store, including the credential of a store inside it that another run uses. The locks only keep the two stores from being leased at the same time.
- Codex guards its token refresh only inside one process. When two interns on one Codex `auth.json` refresh at the same time, they send the same refresh token, the refresh that loses fails with `refresh_token_reused`, and the account can stay signed out until it is signed in again. OpenAI states that one `auth.json` copy serves one machine or one serialized job stream ([Codex CI/CD auth](https://learn.chatgpt.com/docs/auth/ci-cd-auth)).
- A Grok login whose token refresh fails during a turn ends the intern instead of moving it to another login, because Grok reports that failure as `-32603` with text data only.
- A Grok login without a Grok subscription ends the intern instead of moving it to another login, because Grok reports it as `-32603` with `data.http_status` 403, the same shape as a content policy denial.
- An OpenCode intern does not move to another login when its key is rejected or its balance is spent, because OpenCode reports those failures with the same shape as every other failed request.
- When OpenRouter rate-limits a key or fails with a server error, OpenCode retries the request inside the turn up to 5 times and sends nothing meanwhile. Each wait follows the response's `retry-after` header when it has one, so a long value keeps the intern waiting until its time box ends. A testing intern that has made no tool call by then ends as `failed`. When the retries run out first, the turn fails, and the intern ends as `failed`.
- A run replaces the API key of an OpenCode login with `[redacted]`, but not the credentials of Claude, Codex, Cursor, and Grok logins, which their agents can also read and print.
- When an OpenCode Go key reaches its usage limit, OpenCode waits inside the turn until the limit resets and sends nothing meanwhile, so the intern waits out its time box instead of moving to the next login. A testing intern that has made no tool call by then ends as `failed`.
- An OpenCode runner serves OpenCode's HTTP API on its loopback interface without a password, so a command the agent runs can add an MCP server to its own session. The permission rules keep that server's tools from the model, but the model can read the server's resources. That server runs inside the runner and reaches only the hosts the proxy allows.
- When a Grok token refresh fails for good, Grok deletes `auth.json` from the store, and the next run rejects the logins file until you log in to that store again.
- Compose and the Dev Container CLI get only the variables the [target environment contract](#target-environment-contract) lists, and a Docker client configuration without `proxies`. A Docker credential helper that needs another variable, such as `DBUS_SESSION_BUS_ADDRESS`, fails the image pull with `error getting credentials`, the Dev Container CLI downloads features without the proxy variables, and a target image build runs without a proxy. A target that needs one of them lists it in `hostEnv`, and a build that needs a proxy also passes the proxy variables as build arguments.
- BuildKit leaves the proxy build arguments out of its cache key. A target image build therefore reuses a layer that an earlier build on the host cached with the Docker client proxies, and a Dockerfile step that wrote a proxy value into that layer keeps it.
- A run whose teardown fails keeps the values that `secrets` names in the files under `envs/` and `interns/`, and its error says so. A run that ends without its teardown, such as one stopped with SIGKILL, keeps them too. `down` does not remove them.
- `up` prints the seed output unchanged, so the person who uses the environment has the seeded accounts, as interns do. The files of an environment that `up` started keep the values that `secrets` names, because `down` runs in another process, which never read the seed output.
- An environment whose seed output is not one JSON document fails with an error that quotes the output. That output has no fields for `secrets.seed` to name, so the quote keeps any value the target meant to mark.
- Docker keeps the relay's log in the same two 10 MB files as every container log, and the two files hold about 190,000 relay records. When an environment's relay records more connections, Docker drops the older file, about 95,000 records at a time, and the report counts the dropped connections as `unrecorded`.
- A replay intern follows the steps as the earlier run wrote them, with the seed output of the replayed commit. When a change alters the seed output, the steps can name accounts or data that the seed no longer creates, and the intern reports what it saw.
- A replay reads the earlier run's `findings.json`, so a value that `secrets` named there reads `[redacted]` in the steps a replay intern follows. The intern still gets the seed output of the replayed commit unchanged.
- A replay hands each group to one intern, so a failure that shows only some of the time can land under Not reproduced.
- The login store of a Claude, Cursor, or Grok intern is a host directory outside the output disk. The runner can write any number of files there, each up to 1 GiB. The Codex credential file and the generated Codex configuration file are single host files, each capped at 1 GiB.

## Evaluation target

`eval/ledger` is an invoicing application with ten planted defects, listed in `eval/defects.json`. Run QA Interns against it to measure how many defects a run finds:

```
qa-interns run eval/ledger --interns 4
bun eval/score.ts <run>
```

`eval/score.ts` runs one agent on a login from your logins file and writes its files under `envs/score/` and `interns/score/` in the run directory. When its teardown succeeds, it replaces the API key of an OpenCode login with `[redacted]` in those files, as a run does.
