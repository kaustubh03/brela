# Phantom — Silent AI Code Attribution

Know exactly how much of your codebase was written by AI.

Engineering teams increasingly rely on Copilot, Claude Code, and Cursor — but there is no neutral record of which code was AI-generated, by whom, and whether it was reviewed. Phantom runs silently in the background, captures that attribution at the moment code is inserted, and produces governance-ready reports without sending any data off your machine.

---

## Install

```bash
npx phantom init
```

This installs shell wrappers for `claude` and `gh copilot`, writes `pre-commit` and `post-commit` git hooks into `.git/hooks/`, and creates a `.phantom/` directory in your project (gitignored automatically).

---

## Usage

### Set up a project

```bash
cd your-repo
npx phantom init
# Restart your terminal or: source ~/.zshrc
```

### Start the background watcher (optional, for shell-level tracking)

```bash
npx phantom daemon start   # runs detached, PID in .phantom/daemon.pid
npx phantom daemon stop
```

### Generate a report

```bash
# HTML report (default, opens in any browser — no server needed)
npx phantom report

# Analyse last 7 days, write to a specific path
npx phantom report --days 7 --output ./ai-report.html

# Machine-readable JSON to stdout
npx phantom report --format json

# Analyse a different repo
npx phantom report --repo /path/to/other-repo
```

### Manage git hooks manually

```bash
npx phantom hook install     # idempotent — safe to run multiple times
npx phantom hook uninstall   # removes only Phantom's sections, leaves other hooks intact
```

---

## How it works

- **IDE detection** — the VS Code extension watches `onDidChangeTextDocument` for large multi-line insertions and correlates them with active AI extensions (Copilot, Cursor, Codeium). Each detection is written to `.phantom/sessions/YYYY-MM-DD.json` as a newline-delimited JSON entry.

- **Shell detection** — `phantom init` wraps the `claude` and `gh copilot` commands in your shell. Every time you invoke them, a shell intent is logged to `.phantom/shell-intents.jsonl`. The background daemon correlates file changes within 30 seconds of an intent with the tool that triggered them.

- **Commit attribution** — the pre-commit hook checks staged files against today's session data and writes a `{ commitHash, files, tools }` record to `.phantom/commits.jsonl`. The post-commit hook fills in the real commit hash.

---

## Privacy

All data stays local. Nothing leaves your machine. `.phantom/` is gitignored by default — attribution logs, session data, and PID files are never committed.

---

## Contributing

1. Clone the repo: `git clone https://github.com/your-org/phantom`
2. Install dependencies: `npm install`
3. Build all packages: `npm run build`
4. Run unit tests: `npm run test:unit`
5. Run end-to-end tests: `npm run test:e2e`
6. Typecheck: `npm run typecheck`

The monorepo is structured as npm workspaces:

| Package | Purpose |
|---|---|
| `packages/core` | Data model, SidecarWriter, SessionManager |
| `packages/cli` | `phantom` CLI (init, report, hook, daemon) |
| `packages/daemon` | Background file watcher (chokidar) |
| `packages/vscode-extension` | Silent VS Code extension |

All code is TypeScript strict mode. PRs welcome.
