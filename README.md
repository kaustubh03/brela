# Brela — AI Code Attribution

**Brela** tracks which AI tools wrote which lines in your codebase — silently, without changing your workflow.

[![npm](https://img.shields.io/npm/v/@brela-dev/cli)](https://www.npmjs.com/package/@brela-dev/cli)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

## Quick start

```bash
npm install -g @brela-dev/cli
cd your-repo
brela init
```

`brela init` installs shell wrappers, git hooks, and the VS Code extension in one shot.

## Commands

| Command | Description |
|---|---|
| `brela init` | One-command project setup |
| `brela report` | AI attribution breakdown — HTML report with charts, file heatmap, and model breakdown |
| `brela explain <file>` | Full attribution history for a specific file |
| `brela export --git-notes` | Attach attribution as git notes so it travels with the repo |
| `brela daemon start\|stop\|status` | Control the background file-watcher |
| `brela hook install\|uninstall` | Manage git hooks manually |

## Supported AI tools

| Tool | Detection methods |
|---|---|
| GitHub Copilot (inline) | VS Code extension, shell wrapper |
| GitHub Copilot Agent | VS Code extension, multi-file burst |
| GitHub Copilot CLI | Shell wrapper |
| Claude Code (inline + agent) | Shell wrapper, external file write |
| Cursor (inline + Composer) | VS Code extension, multi-file burst |
| Cline | VS Code extension |
| Continue | VS Code extension |
| Aider | Shell wrapper, external file write |
| ChatGPT paste | Large-insertion heuristic |

## How it works

1. **Shell wrappers** — `brela init` wraps `claude`, `gh copilot`, and other AI CLIs in your shell. Every invocation logs `{ tool, timestamp }` to `.brela/shell-intents.jsonl`
2. **VS Code extension** — watches `onDidChangeTextDocument` and `onDidSaveTextDocument`; attributes large insertions, agent saves, and file creations to the correct tool
3. **Daemon** — background chokidar watcher diffs files before/after AI writes to record exact line ranges
4. **Git hooks** — pre-commit captures staged AI attributions; post-commit fills in the real commit hash
5. **Session files** — every attribution is appended to `.brela/sessions/YYYY-MM-DD.json` (NDJSON, local only)
6. **Git notes** — `brela export --git-notes` attaches the attribution payload to each commit so CI, audits, and new team members can see it

## Line-level tracking

The daemon records the exact lines AI wrote, not just a count:

```
brela explain src/api/payments.ts
```

```
2026-03-23 10:31  ● Claude Code Agent    L1-12, L45-79  HIGH
```

To also capture the code itself (for audits), enable it in `.brela/config.json`:

```json
{ "captureCode": true }
```

Then restart the daemon. Turn it off the same way to remove the clutter.

## Git notes export

Share attribution with the team without committing `.brela/` to the repo:

```bash
brela export --git-notes          # attach notes to all attributed commits
brela export --git-notes --push   # also push refs/notes/brela to origin
```

Teammates pull and view:

```bash
git fetch origin refs/notes/brela:refs/notes/brela
git log --show-notes=brela
```

## Packages

| Package | npm | Description |
|---|---|---|
| [`@brela-dev/core`](./packages/core) | [![npm](https://img.shields.io/npm/v/@brela-dev/core)](https://www.npmjs.com/package/@brela-dev/core) | Shared types, `SidecarWriter`, `BrelaConfig` |
| [`@brela-dev/cli`](./packages/cli) | [![npm](https://img.shields.io/npm/v/@brela-dev/cli)](https://www.npmjs.com/package/@brela-dev/cli) | CLI — all `brela` commands |
| [`@brela-dev/daemon`](./packages/daemon) | [![npm](https://img.shields.io/npm/v/@brela-dev/daemon)](https://www.npmjs.com/package/@brela-dev/daemon) | Background file-watcher daemon |
| [`brela-vscode`](./packages/vscode-extension) | [Marketplace](https://marketplace.visualstudio.com/items?itemName=brela.brela-vscode) | VS Code extension |

## Privacy

All data is local. Nothing leaves your machine. `.brela/` is gitignored automatically by `brela init`.

## Brela Cloud

The open-source CLI gives you per-developer, per-repo attribution. **[Brela Cloud](https://usebrela.com)** adds:

- Org-wide dashboards across all repos and engineers
- AI cost & ROI tracking
- SOC 2 / compliance-ready exports
- Per-engineer attribution and review workflows
- Risk alerts for unreviewed AI PRs
- Jira / Linear / GitHub sync

## Changelog

See [CHANGELOG.md](CHANGELOG.md) for the full release history.

## Development

```bash
git clone https://github.com/kaustubh03/brela
cd brela
npm install
npm run build
```

### Monorepo structure

| Package | Purpose |
|---|---|
| `packages/core` | `AITool` enum, `AttributionEntry` type, `SidecarWriter`, `BrelaConfig` |
| `packages/cli` | All CLI commands (`init`, `report`, `explain`, `export`, `hook`, `daemon`) |
| `packages/vscode-extension` | Silent VS Code extension — detection and recording |
| `packages/daemon` | Background chokidar watcher with line-level diff |

## License

MIT
