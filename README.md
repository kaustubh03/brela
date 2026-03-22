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
| [`@brela/api`](./packages/api) | Backend API — auth, reports, usage data, email digests |

## Quick start

```bash
# Install CLI
npm install -g brela

# In your project root
brela init

# See today's attribution report
brela report
```

## API Server

The `@brela/api` package provides a Fastify-based backend for persistent storage, authentication, and automated reporting.

**Tech stack:** Node.js + Fastify, Supabase (Postgres), Supabase Auth (GitHub/Google OAuth), pg_cron

```bash
# Copy env template and configure Supabase credentials
cp packages/api/.env.example packages/api/.env

# Start the API server in dev mode
npm run dev:api

# Health check
curl http://localhost:3001/health
```

**API routes** (all under `/api/v1`):

| Route | Method | Description |
|---|---|---|
| `/auth/signin` | POST | Initiate GitHub/Google OAuth |
| `/auth/callback` | GET | OAuth callback |
| `/auth/refresh` | POST | Refresh access token |
| `/auth/me` | GET | Current user profile |
| `/auth/profile` | PATCH | Update profile |
| `/reports` | GET/POST | List & create report snapshots |
| `/reports/:id` | GET/DELETE | Get or delete a report |
| `/usage/ingest` | POST | Batch ingest attribution events |
| `/usage` | GET | Query aggregated usage data |
| `/usage/events` | GET | Raw attribution events |
| `/emails/digest/trigger` | POST | Trigger weekly digest emails |
| `/emails/digests` | GET | Digest email history |

## How it works

1. `brela init` installs a VS Code extension, git hooks, and shell wrappers
2. Every large insertion, agent file-write, or commit with a Claude co-author trailer is recorded to `.brela/sessions/YYYY-MM-DD.json`
3. `brela report` reads the session files and prints a breakdown

## License

MIT
