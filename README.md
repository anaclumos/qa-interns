# QA Interns

QA Interns runs many AI QA interns against a web application at once. Each intern gets its own copy of the application and its backing services, uses the application through a real browser and HTTP, and tries to break it. An intern reports what breaks and the exact conditions under which it breaks. An intern never fixes code, suggests a fix, ranks severity, or guesses a cause.

The design and its scope are in [issue #1](https://github.com/anaclumos/qa-interns/issues/1).

## Requirements

- Linux on x86-64. Chrome for Testing has no Linux ARM64 build.
- Docker Engine with Compose 5.0 or later, the `isolated` bridge gateway mode, and privileged containers that can use loop devices. QA Interns mounts each intern's output disk from such a container, so the state directory must be on a mount with shared propagation, which is the systemd default. `qa-interns doctor` checks all of these. Compose 2 drops `env_file` paths from `docker compose config --no-env-resolution`, which the target checks read.
- Bun 1.4 or later, Git, and `flock` from util-linux.
- At least one agent login: Claude Code, Codex, Cursor, or Grok (see [Logins](#logins)).
- Memory for the environments you run at once. An environment reserves 2 GiB for its runner, 128 MiB for its proxy, 128 MiB for its relay when the target lists `egress` hosts, and each service's `mem_limit` (1 GiB when the service sets none) times its `scale` or `deploy.replicas`.

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
| `qa-interns validate <target-dir> [--commit <rev>]` | Checks the target's dev container and Compose files at the commit (default `HEAD`) as `run` does before it builds images. Needs no logins, no runner image, and no value for a `hostEnv` variable that no checked setting reads (see [Target environment contract](#target-environment-contract)). |
| `qa-interns run <target-dir> [--commit <rev>] [--interns <n>] [--minutes <n>] [--confirm-minutes <n>] [--logins <file>]` | Runs interns against the target at the commit (default `HEAD`, 4 interns, 30 minutes each, 10 minutes per confirmation). Prints the run directory first. |
| `qa-interns up <target-dir> [--commit <rev>]` | Starts one environment of the target at the commit (default `HEAD`) with no interns, runs its `ready` check and `seed`, and leaves it running. Prints the run directory first, then the Compose project, the IDs of the runner and the dev container, and the seed output. When a step fails, it tears the environment down. `qa-interns down` removes the environment. |
| `qa-interns status [<run>]` | Prints the phase and every intern's status. |
| `qa-interns report [<run>]` | Prints `report.md`. |
| `qa-interns down [<run>]` | Stops the run's orchestrator with SIGTERM when that process, matched by its pid and start time, is still running. Then tears down every environment the run still has, saves each output disk the run left into its folder, and deletes the run's leftover workspace copies, with containers of the current runner image. When disks or copies are left and that image does not exist, it fails; build the image with `qa-interns doctor` and run `down` again. |

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
      "egress": ["api.pwnedpasswords.com"]
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
- `egress` (optional): outside hosts that the target services reach over TLS on port 443, such as HTTPS, for a service that has no local stand-in, such as a hosted model API. Each entry is an exact lowercase host name; a wildcard or an IP address is rejected. When such a host needs a credential, a target service takes it from a variable that `hostEnv` names.

`run` rejects a target whose Compose files have any of these, because each collides across copies or gives the application the interns attack access to the host:

- A `dockerComposeFile` entry outside the target directory, so the tested services always come from the commit.
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

`qa-interns validate` exports the target at the commit as `run` does and applies the checks above, except the checks after `devcontainer up`, which need a started environment. It uses the host value of each `hostEnv` variable that the host sets. When a `hostEnv` variable is not set, `validate` renders the Compose files twice, with each unset `hostEnv` variable set to `./qa-interns-unset-<name>-1` and then to `./qa-interns-unset-<name>-2`, and fails when a setting that the checks read differs between the two renders, such as a bind mount source built from the variable. A variable that only a service's `environment` reads, such as an API key, needs no value. Set a variable that a checked setting reads to the value `run` uses.

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

A login is a `store` directory or a `seat` command, with a `concurrency` limit (default 1).

| Provider | Store | How to fill it |
| --- | --- | --- |
| `claude` | A directory with `.credentials.json`. Only `.credentials.json` is mounted into the runner. | `CLAUDE_CONFIG_DIR=<store> claude /login` |
| `codex` | A directory with `auth.json`. Only `auth.json` is mounted into the runner. | `CODEX_HOME=<store> codex login` |
| `cursor` | A Cursor credential directory with `auth.json`, mounted whole as `$XDG_CONFIG_HOME/cursor`. Use a directory that only QA Interns uses. | `XDG_CONFIG_HOME=<parent of store> cursor-agent login`, with the store named `cursor` |
| `grok` | A directory with `auth.json`, mounted whole, because Grok replaces the file when it refreshes the token. A runner writes only `auth.json` and its lock file there. Use a directory that only QA Interns uses. | `GROK_HOME=<store> grok login` |

- Each running intern holds one lease on one login. A Codex store has `concurrency` 1, because OpenAI states that one `auth.json` copy serves one machine or one serialized job stream ([Codex CI/CD auth](https://learn.chatgpt.com/docs/auth/ci-cd-auth)).
- A lease locks the real path of what the runner mounts until the lease ends: the credential file of a Claude or Codex store, and the whole store of a Cursor or Grok store. The locks live in `~/.local/state/qa-interns/locks/` (`$XDG_STATE_HOME` when set). Runs that share that directory hold, all together, no more leases on one credential than the highest `concurrency` any of them sets for it. They also never hold two leases at once when the mounted path of one contains the mounted path of the other, such as a Cursor store and a Codex store inside it.
- A seat command is an external program that hands out a store for one intern. It runs with `QA_INTERNS_INTERN` and `QA_INTERNS_LEASE_PID` in its environment and prints an absolute store path as its last line. `QA_INTERNS_LEASE_PID` is a process that lives exactly as long as the intern holds the store, and ends when the orchestrator ends, so a pool manager can hold the store until that process exits. A nonzero exit means the seat command has no store now. The printed store is checked like a configured store, against every configured store and every store an intern holds, and a store that fails a check counts as no store.
- When an agent reports a usage limit or a failed login, the intern moves to another login with spare capacity and restarts its charter in a fresh environment with an empty `/qa/out`. The findings of the earlier attempt stay in the report, and `findings.json` records the provider and model of the attempt that wrote each one. A confirming intern that moves answers with the `confirmation.json` of its latest attempt that wrote a valid one, under that attempt's provider. Claude reports a usage limit as JSON-RPC error `-32603` with `data.errorKind` `rate_limit` or `billing_error`, and Codex as `-32603` with `data.codexErrorInfo` `usageLimitExceeded`. Grok reports a rate or usage limit as `-32003`, and spent credits or a rejected token as `-32603` with `data.http_status` 402 or 401. Cursor ends the turn with a chat message instead of an error, so a Cursor intern at its limit stops early and the report quotes its last message.

## What a run does

1. Exports the target at the commit and checks its dev container and Compose files.
2. Builds the target's images once.
3. Starts one environment per intern, each as its own Compose project on its own isolated network, at most as many at once as free memory, login capacity, and free network slots allow, and at most four starting at a time. Checks each dev container that `devcontainer up` created.
4. Starts one agent per intern inside that intern's runner container, over the Agent Client Protocol.
5. Gives each intern the rules, one charter, the application URLs, and the seeded accounts. The intern tests until its time box ends and writes each finding as JSON.
6. Groups duplicate findings in one judge pass, then hands each group to a different intern in a fresh environment, on a different provider when one is free, which reproduces it from the written finding alone.
7. Writes the report and tears down every environment, on success, on failure, and on interrupt.

## Run directory and report

Runs live in `~/.local/state/qa-interns/runs/<run-id>/` (`$XDG_STATE_HOME` when set):

- `report.md`: confirmed findings first, then findings seen once, then finding files that failed validation, then the interns.
- `findings.json`: the same data as JSON.
- `interns/<id>/out/`: each intern's findings and evidence (screenshots, recordings, HAR files, console logs). After a move to another login, the next attempt writes to `interns/<id>/out-2/`, the one after it to `out-3/`, and so on. The id of a finding from such an attempt names its folder, as in `i1/out-2/<slug>`.
- `interns/<id>/transcript.jsonl`: the agent traffic of each intern.
- `interns/<id>/adapter.log`: the error output of each intern's agent.
- Each transcript and error log stops growing at 64 MiB. Later traffic and output are not recorded.
- `state.json`: the run's phase and every intern's status.

A finding is confirmed when two or more interns reproduced it.

## Isolation

- Every environment is its own Compose project with its networks in its own `/23` block of `10.213.0.0/16`. The target services and the runner share one internal network, and the runner and the proxy share a second internal network. An environment that `up` starts has no proxy and no second network. When the target lists `egress` hosts, the target services and the relay share a third internal network. Only the proxy and the relay join the network that reaches the internet. The internal networks have no gateway address, so containers on them reach neither the host nor other environments.
- The runner container holds the agents, agent-browser with Chrome for Testing, ffmpeg, and curl. It has no source mount, no Docker socket, a read-only root file system, and no capabilities. It can write only to `/qa/out`, `/tmp`, and its home directory, and holds no credential beyond its own login. It can also write the login credential it was given, which is the credential file for Claude and Codex and the whole store directory for Cursor and Grok, and that write reaches the store on the host.
- `/qa/out` is a 1 GiB ext4 disk of its own for each attempt, mounted on that attempt's folder under `interns/<id>/`. The kernel stops every write past the disk's size or its inode count, including writes to files deleted while still open and space reserved without writing. A privileged helper container from the runner image, with the host `/dev`, creates and mounts the disk before the environment starts. At teardown, the helper copies the disk into the folder and deletes the disk image. The runner cannot write a file larger than 1 GiB anywhere. While the agent runs, the orchestrator checks the disk once a second and stops the runner when the disk is full. The intern then ends as failed, and the findings it wrote stay in the report.
- The orchestrator keeps an agent's output in memory until a newline arrives. An intern fails when its agent prints more than 64 MiB without a newline, or when the orchestrator's messages to the agent pass 64 MiB in total.
- The runner reaches the internet only through a proxy container that allows HTTPS to the model provider hosts and nothing else.
- Docker keeps the log of every container in an environment, the target services included, with the `local` log driver, whatever log driver and options the Docker daemon or the target's Compose files set. Each log is a current file and the previous file. Docker starts a new current file once the current file holds 10 MB, and then compresses the previous file. A log of data that does not compress takes up to about 20 MB, and up to about 30 MB while that compression runs.
- Target services cannot reach the proxy. They reach the internet only through a relay container, and only the `egress` hosts over TLS on port 443. Each target service resolves those hosts to the relay through its hosts file and starts after the relay accepts connections. The relay reads the host name from the TLS handshake, refuses any other host and any connection that does not start with a TLS handshake, and passes the encrypted connection through unchanged, so the application needs no proxy setting and checks the real server's certificate. The relay does not check which protocol runs inside TLS. Lifecycle commands that run in a target container, and application code, fail when they need any other host.
- Every agent session starts with no MCP servers. Claude and Codex have their MCP sources blocked in `src/providers.ts`. Grok has them blocked by the root-owned `/etc/grok/requirements.toml` in the runner image. A Cursor runner has no MCP source, because its home directory is an empty tmpfs and `CURSOR_CONFIG_DIR` keeps Cursor's settings and sessions in that home, out of the store.
- Chrome runs with `--no-sandbox`, because Docker's default seccomp profile blocks its sandbox, so the container is the boundary. A compromised renderer can read what the runner user can read, including that intern's login.

## Known limits

- Single-container dev containers are not supported yet.
- The runner image is x86-64 only.
- Two runs that start an environment at the same moment can pick the same subnet; the second fails to start that environment.
- `validate` sets an unset `hostEnv` variable to a placeholder that is not empty. A checked setting that changes only when the variable is empty, such as one built with `${VAR:+...}`, passes `validate` and can fail `run` when the variable is empty. A variable in a setting that Compose reads as a number or a boolean, such as `scale` or `privileged`, fails `validate` with a Compose error that quotes the placeholder.
- A Cursor usage limit ends the intern early instead of moving it to another login.
- An intern waits for a login only while its own run holds a lease. When other runs hold every login it could use, the intern ends as `limited`.
- Credential locks and the store checks compare real paths, so two hard links to one credential file count as two credentials.
- A Cursor or Grok runner can read and change every file in its store, including the credential of a store inside it that another run uses. The locks only keep the two stores from being leased at the same time.
- A Grok login whose token refresh fails during a turn ends the intern instead of moving it to another login, because Grok reports that failure as `-32603` with text data only.
- A Grok login without a Grok subscription ends the intern instead of moving it to another login, because Grok reports it as `-32603` with `data.http_status` 403, the same shape as a content policy denial.
- When a Grok token refresh fails for good, Grok deletes `auth.json` from the store, and the next run rejects the logins file until you log in to that store again.
- Compose and the Dev Container CLI get only the variables the [target environment contract](#target-environment-contract) lists, and a Docker client configuration without `proxies`. A Docker credential helper that needs another variable, such as `DBUS_SESSION_BUS_ADDRESS`, fails the image pull with `error getting credentials`, the Dev Container CLI downloads features without the proxy variables, and a target image build runs without a proxy. A target that needs one of them lists it in `hostEnv`, and a build that needs a proxy also passes the proxy variables as build arguments.
- BuildKit leaves the proxy build arguments out of its cache key. A target image build therefore reuses a layer that an earlier build on the host cached with the Docker client proxies, and a Dockerfile step that wrote a proxy value into that layer keeps it.
- The login store of a Cursor or Grok intern is a host directory outside the output disk. The runner can write any number of files there, each up to 1 GiB. The Claude and Codex credential files and the generated Codex configuration file are single host files, each capped at 1 GiB.

## Evaluation target

`eval/ledger` is an invoicing application with ten planted defects, listed in `eval/defects.json`. Run QA Interns against it to measure how many defects a run finds:

```
qa-interns run eval/ledger --interns 4
bun eval/score.ts <run>
```
