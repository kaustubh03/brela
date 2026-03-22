# @brela-dev/cli

CLI for [Brela](https://github.com/kaustubh03/brela) — set up AI code attribution in any project with one command.

Brela runs silently in the background and tracks which AI tools wrote which lines: GitHub Copilot, Claude Code, Cursor, Windsurf, Cline, Aider, Continue, and more. All data stays local — nothing leaves your machine.

## Install

```bash
npm install -g @brela-dev/cli
```

## Commands

### `brela init`

One-command project setup. Run once in your project root:

```bash
cd your-repo
brela init
```

What it does:
- Adds shell wrappers to `.zshrc` / `.bashrc` so `claude` and `gh copilot` log intent before running
- Installs the `brela-vscode` VS Code extension
- Starts the background daemon that watches for agent file writes
- Creates `.brela/` session directory and git pre-commit hook

### `brela report`

Print an AI attribution breakdown:

```bash
brela report              # today
brela report --days 7     # last 7 days
brela report --from 2024-01-01 --to 2024-01-31
```

### `brela explain <file>`

Full attribution history for a specific file:

```bash
brela explain src/utils/api.ts
brela explain src/utils/api.ts --days 30
brela explain src/utils/api.ts --json
brela explain src/utils/api.ts --since 2026-03-01
```

Shows:
- Attribution summary (tools, events, chars inserted)
- Timeline of every AI event in that file
- Risk assessment (unreviewed AI sections, test coverage)

### `brela daemon`

Control the background file-watcher daemon:

```bash
brela daemon start
brela daemon stop
brela daemon status
```

Started automatically by `brela init`.

### `brela hook`

Manually install or uninstall git hooks:

```bash
brela hook install
brela hook uninstall
```

## Session data

All data is local to your project under `.brela/` (gitignored automatically):

```
.brela/
  sessions/            # NDJSON attribution log, one file per day
  shell-intents.jsonl  # written by shell wrappers before AI CLI runs
  daemon.pid
```

## Part of Brela

See the [root repo](https://github.com/kaustubh03/brela) for the VS Code extension and full documentation.
