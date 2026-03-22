# Brela — AI Attribution (VS Code Extension)

Silently tracks which AI tools wrote which lines in your codebase — without changing your workflow.

Brela watches your editor in the background and records every AI-generated insertion: GitHub Copilot completions, Claude Code agent writes, Cursor suggestions, Windsurf, Cline, and more. Run `brela report` or `brela explain <file>` to see a breakdown anytime.

## Features

- **Zero friction** — no UI, no popups, no workflow changes
- **Accurate attribution** — distinguishes inline completions from agent writes; correctly separates Copilot Chat from Claude Code; CLI agent runs from extension completions
- **All major tools** — Copilot, Copilot CLI, Claude Code, Cursor, Windsurf, Cline, Continue, Aider
- **Local only** — all session data stays in `.brela/` inside your project, never sent anywhere

## How it works

The extension runs three listeners silently:

1. **`onDidChangeTextDocument`** — detects large multi-line insertions (≥3 newlines, ≥120 chars) and attributes them to the active AI extension
2. **`onDidSaveTextDocument`** — catches agent saves (files written directly to disk by a CLI agent)
3. **File creation watcher** — records new files created by agents

Shell intent from `brela` shell wrappers (`claude`, `gh copilot`) takes highest priority — so `CLAUDE_CODE_AGENT` is always correctly separated from Copilot Chat.

## Detection logic

| Scenario | Attributed as |
|---|---|
| Large insertion, only Copilot active | `COPILOT` |
| Large insertion, only Claude Code active | `CLAUDE_CODE` |
| Both Copilot + Claude Code active | `COPILOT` (conservative — inline is ambiguous) |
| File saved after `claude` shell run | `CLAUDE_CODE_AGENT` |
| File saved after `gh copilot` shell run | `COPILOT_CLI` |
| Cursor extension or `.cursorrules` | `CURSOR` |
| Windsurf extension or `.windsurfrules` | `CODEIUM` |
| 2+ files changed within 2 seconds | `MULTI_FILE_BURST` |
| Git commit has `Co-Authored-By: Claude` | `CLAUDE_CODE` |

## Setup

The extension is installed automatically by `brela init`. To install manually:

```bash
npm install -g @brela-dev/cli
brela init
```

## Session files

Attributions are written to `.brela/sessions/YYYY-MM-DD.json` in your workspace (NDJSON). Use `brela report` or `brela explain <file>` from the `@brela-dev/cli` package to read them.

## Part of Brela

See the [root repo](https://github.com/kaustubh03/brela) for the CLI, core types, and full documentation.
