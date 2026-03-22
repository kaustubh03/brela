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
# Install CLI
npm install -g brela

# In your project root
brela init

# See today's attribution report
brela report
```

## How it works

1. `brela init` installs a VS Code extension, git hooks, and shell wrappers
2. Every large insertion, agent file-write, or commit with a Claude co-author trailer is recorded to `.brela/sessions/YYYY-MM-DD.json`
3. `brela report` reads the session files and prints a breakdown

## License

MIT
