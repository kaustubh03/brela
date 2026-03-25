# Brela — AI Code Attribution

**Brela** tracks which AI tools wrote which lines in your codebase — silently, without changing your workflow.

## What it does

- Detects AI-generated code from GitHub Copilot, Claude Code, Cursor, Windsurf, Cline, Aider, Continue, and more
- Attributes insertions to the correct tool via VS Code extension hooks, shell wrappers, and git hooks
- Reports a breakdown of AI vs human contributions per file, author, or date range

## Packages

| Package | Description |
|---|---|
| [`@brela/core`](./packages/core) | Shared types and session writer |
| [`brela`](./packages/cli) | CLI — `brela init`, `brela report`, `brela hook` |
| [`brela-vscode`](./packages/vscode-extension) | VS Code extension — silent background attribution |

## Quick start

```bash
npm install -g @brela-dev/cli
cd your-repo
brela init
```

## Commands

| Command | Description |
|---|---|
| `brela init` | One-command project setup |
| `brela report` | AI attribution breakdown (today, last N days, or date range) |
| `brela explain <file>` | Full attribution history for a specific file |
| `brela daemon start\|stop\|status` | Control the background file-watcher |
| `brela hook install\|uninstall` | Manage git hooks manually |

## Supported AI tools

Copilot, Copilot CLI, Claude Code (inline + agent), Cursor, Windsurf, Cline, Continue, Aider, ChatGPT paste

## Packages

| Package | npm | Description |
|---|---|---|
| [`@brela-dev/core`](./packages/core) | [![npm](https://img.shields.io/npm/v/@brela-dev/core)](https://www.npmjs.com/package/@brela-dev/core) | Shared types and session writer |
| [`@brela-dev/cli`](./packages/cli) | [![npm](https://img.shields.io/npm/v/@brela-dev/cli)](https://www.npmjs.com/package/@brela-dev/cli) | CLI — all `brela` commands |
| [`brela-vscode`](./packages/vscode-extension) | [Marketplace](https://marketplace.visualstudio.com/items?itemName=brela.brela-vscode) | VS Code extension |

## How it works

1. **Shell wrappers** — `brela init` wraps `claude` and `gh copilot` in your shell. Every invocation logs `{ tool, timestamp }` to `.brela/shell-intents.jsonl`
2. **VS Code extension** — watches `onDidChangeTextDocument` and `onDidSaveTextDocument`; attributes large insertions, agent saves, and file creations to the correct tool
3. **Session files** — every attribution is appended to `.brela/sessions/YYYY-MM-DD.json` (NDJSON, local only)
4. **Report / Explain** — `brela report` and `brela explain <file>` read session files and display breakdowns

## Privacy

All data is local. Nothing leaves your machine. `.brela/` is gitignored automatically by `brela init`.

## Development

```bash
git clone https://github.com/kaustubh03/brela
cd brela
npm install
npm run build
npm run test:unit
```

### Monorepo structure

| Package | Purpose |
|---|---|
| `packages/core` | `AITool` enum, `AttributionEntry` type, `SidecarWriter` |
| `packages/cli` | All CLI commands (`init`, `report`, `explain`, `hook`, `daemon`) |
| `packages/vscode-extension` | Silent VS Code extension — detection and recording |
| `packages/daemon` | Background chokidar file watcher |

## License

MIT
