---
name: qa-interns
description: Start a QA Interns run against a target application at one commit or its working tree in the background, then report its findings when the run ends. Use when the user asks to run QA interns against an application.
argument-hint: <target-dir> [--commit <rev> | --dirty] [--interns <n>] [--minutes <n>] [--logins <file>]
disable-model-invocation: true
allowed-tools: Bash(bun ${CLAUDE_PLUGIN_ROOT}/src/cli.ts *) Read
---

1. Run `bun ${CLAUDE_PLUGIN_ROOT}/src/cli.ts run $ARGUMENTS` with the Bash tool and `run_in_background: true`.
2. Read the task output file once. Its first line is the run directory. Tell the user the run directory, and that the run stops if this session ends.
3. Wait for the completion notification. Do not poll and do not sleep.
4. When the task exits with code 0, read `<run directory>/report.md` and relay the confirmed findings, then the count of findings that were not confirmed. Relay each confirmed finding with every image the report embeds for it, as a Markdown image with the absolute path the report gives. Quote the report; do not add fixes, causes, or severity.
5. When the task exits with another code, show the last 40 lines of the task output file and the output of `bun ${CLAUDE_PLUGIN_ROOT}/src/cli.ts status <run directory>`. When the output has no run directory, because the run failed before it started, show the last 40 lines only.
