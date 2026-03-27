# Changelog

All notable changes to Brela are documented here.

---

## [Unreleased]

### Added
- **Report: Brela Cloud promo section** — blurred teaser of org-wide analytics with CTA overlay promoting Brela Cloud. Shown at the bottom of every HTML report.
- **Report: Brela logo** — replaced emoji favicon/nav icon with the actual VS Code extension `icon.png`, embedded as a base64 data URL so reports are fully self-contained.
- **Report: "Explore Brela Cloud" nav button** — quick-access link in the report navbar.
- **Report: AI Lines Daily Trend** — renamed chart, removed misleading "Human Lines" dataset (git commit dates don't align with attribution dates when multi-day work is committed at once).
- **Core: `ModelResolver.resolveOrNull()`** — returns `null` instead of a hardcoded default when no model is found in config or SQLite. Prevents wrong defaults being persisted in session files.
- **CLI: model re-resolution at report/explain time** — `brela report` and `brela explain` now re-resolve missing models from SQLite at CLI time, picking up entries recorded before model resolution was added.

### Fixed
- **Report: empty charts** — Chart.js 4 requires both `canvas.width/height` and `canvas.style.width/height`. Added `setCanvas()` helper and switched from `window.load` to `DOMContentLoaded` + `setTimeout` for reliable chart init on `file://` URLs.
- **Report: inflated human line count** — git diff was counting non-source files (`.html` reports, lock files, `dist/`, `build/`, generated files). Added a source-file filter so only real code lines are counted.
- **Report: Copilot model hidden** — Copilot tools (inline, agent, CLI) no longer show a model string in the report. The VS Code chat model selection does not reliably reflect per-completion model, so it is omitted to avoid misleading data.
- **VS Code extension: wrong default model** — extension was falling back to `gpt-4o` when `better-sqlite3` was unavailable in the bundled context. Now stores `undefined` via `resolveOrNull()` and defers resolution to CLI time.
- **VS Code extension: `better-sqlite3` bundling** — added to esbuild `external` list so the native addon is not inlined (it cannot be bundled).

---

## [0.1.5] — 2026-03-15

### Fixed
- VS Code extension auto-install during `brela init` — installer now correctly locates and installs the `.vsix` bundle.

---

## [0.1.4] — 2026-03-10

### Fixed
- Daemon tool mapping — attribution events now correctly map to the right `AITool` enum value for all supported tools.
- Copilot daemon support — Copilot agent and inline completions are now tracked correctly by the background daemon.

### Removed
- Backfill command — removed to simplify the surface area.

---

## [0.1.1] — 2026-02-20

### Added
- Initial alpha release published to npm.
- `brela init` — one-command setup: shell wrappers, git hooks, VS Code extension.
- `brela report` — HTML attribution report with tool breakdown, daily trend, file heatmap.
- `brela explain <file>` — per-file attribution history with line ranges.
- `brela export --git-notes` — attach attribution payload as git notes.
- `brela daemon start|stop|status` — background chokidar watcher for line-level diffs.
- `brela hook install|uninstall` — manual git hook management.
- VS Code extension (`brela-vscode`) — silent detection via `onDidChangeTextDocument` / `onDidSaveTextDocument`.
- Support for: GitHub Copilot, Copilot CLI, Claude Code (inline + agent), Cursor, Cursor Agent, Cline, Continue, Aider, ChatGPT paste.
- Session files stored locally at `.brela/sessions/YYYY-MM-DD.json`.
- `captureCode` config flag to optionally store AI-written source lines in session files.

---

## [0.1.0-alpha.1] — 2026-01-28

### Added
- Initial open-source release with core attribution pipeline.
