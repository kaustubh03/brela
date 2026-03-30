import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import Database from 'better-sqlite3';
import { AITool } from './types.js';

// ── Default model per tool ────────────────────────────────────────────────────

const DEFAULTS: Record<AITool, string> = {
  [AITool.CLAUDE_CODE]:       'claude-sonnet-4-5',
  [AITool.CLAUDE_CODE_AGENT]: 'claude-sonnet-4-5',
  [AITool.COPILOT]:           'gpt-4o',
  [AITool.COPILOT_AGENT]:     'gpt-4o',
  [AITool.COPILOT_CLI]:       'gpt-4o',
  [AITool.CURSOR]:            'claude-3-5-sonnet',
  [AITool.CURSOR_AGENT]:      'claude-3-5-sonnet',
  [AITool.CODEIUM]:           'unknown',
  [AITool.CLINE]:             'unknown',
  [AITool.AIDER]:             'gpt-4o',
  [AITool.CODEX_CLI]:         'codex-mini',  // Codex CLI default as of v0.1 (https://github.com/openai/codex)
  [AITool.CONTINUE]:          'unknown',
  [AITool.CHATGPT_PASTE]:     'unknown',
  [AITool.UNKNOWN]:           'unknown',
  [AITool.GENERIC_AGENT]:     'unknown',
};

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Parse a JSON file, returning null on any error. */
function readJson(filePath: string): Record<string, unknown> | null {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}

/** Return a non-empty string value for a key, or null. */
function str(obj: Record<string, unknown>, key: string): string | null {
  const v = obj[key];
  return typeof v === 'string' && v.trim().length > 0 ? v.trim() : null;
}

/**
 * Navigate a dot-separated key path through nested objects/arrays.
 * e.g. deepGet(obj, 'models.0.model') → obj.models[0].model
 */
function deepGet(obj: Record<string, unknown>, keyPath: string): string | null {
  let cur: unknown = obj;
  for (const part of keyPath.split('.')) {
    if (cur === null || cur === undefined) return null;
    if (Array.isArray(cur)) {
      const idx = parseInt(part, 10);
      cur = Number.isNaN(idx) ? undefined : cur[idx];
    } else if (typeof cur === 'object') {
      cur = (cur as Record<string, unknown>)[part];
    } else {
      return null;
    }
  }
  return typeof cur === 'string' && cur.trim().length > 0 ? cur.trim() : null;
}

/** VS Code settings.json path — platform-aware. */
function vsCodeSettingsPath(): string {
  const home = os.homedir();
  if (process.platform === 'win32') {
    const appData = process.env['APPDATA'] ?? path.join(home, 'AppData', 'Roaming');
    return path.join(appData, 'Code', 'User', 'settings.json');
  }
  if (process.platform === 'darwin') {
    return path.join(home, 'Library', 'Application Support', 'Code', 'User', 'settings.json');
  }
  return path.join(home, '.config', 'Code', 'User', 'settings.json');
}

/** VS Code global state SQLite DB path — platform-aware. */
function vsCodeStatePath(): string {
  const home = os.homedir();
  if (process.platform === 'win32') {
    const appData = process.env['APPDATA'] ?? path.join(home, 'AppData', 'Roaming');
    return path.join(appData, 'Code', 'User', 'globalStorage', 'state.vscdb');
  }
  if (process.platform === 'darwin') {
    return path.join(home, 'Library', 'Application Support', 'Code', 'User', 'globalStorage', 'state.vscdb');
  }
  return path.join(home, '.config', 'Code', 'User', 'globalStorage', 'state.vscdb');
}

/**
 * Read a single key from the VS Code global state SQLite DB.
 * Returns null on any error so callers can fall back gracefully.
 */
function readVsCodeState(key: string): string | null {
  const dbPath = vsCodeStatePath();
  if (!fs.existsSync(dbPath)) return null;
  try {
    const db  = new Database(dbPath, { readonly: true, fileMustExist: true });
    const row = db.prepare('SELECT value FROM ItemTable WHERE key = ?').get(key) as
      { value: string } | undefined;
    db.close();
    return row?.value ?? null;
  } catch {
    return null;
  }
}

/**
 * Resolve the active Copilot model from VS Code's state database.
 *
 * Priority:
 *   1. `chat.currentLanguageModel.panel`  — the model currently selected in the UI
 *      (may be "copilot/auto"; if so, fall through to recently-used)
 *   2. First entry of `chatModelRecentlyUsed` — most recently confirmed selection
 *   3. null (caller falls back to DEFAULTS)
 */
function resolveCopilotModel(): string | null {
  // 1. Active panel model
  const active = readVsCodeState('chat.currentLanguageModel.panel');
  if (active && active !== 'copilot/auto') {
    return active.replace(/^copilot\//, '');
  }

  // 2. Most-recently used (first entry)
  const recentRaw = readVsCodeState('chatModelRecentlyUsed');
  if (recentRaw) {
    try {
      const recent = JSON.parse(recentRaw) as unknown;
      if (Array.isArray(recent) && recent.length > 0 && typeof recent[0] === 'string') {
        return (recent[0] as string).replace(/^copilot\//, '');
      }
    } catch {
      // malformed — ignore
    }
  }

  return null;
}

/**
 * Extract a value from an `.aider.conf.yml` file without pulling in a full
 * YAML parser. Only handles simple scalar values: `model: <value>`.
 */
function readAiderYml(filePath: string): string | null {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const m = raw.match(/^model:\s*(.+)$/m);
    if (m && m[1]) {
      const val = m[1].trim().replace(/^['"]|['"]$/g, ''); // strip optional quotes
      return val.length > 0 ? val : null;
    }
    return null;
  } catch {
    return null;
  }
}

// ── ModelResolver ─────────────────────────────────────────────────────────────

export class ModelResolver {
  /**
   * Resolve the active model for a given tool.
   *
   * Priority (highest → lowest):
   *   1. `explicitModel` — parsed from `--model` flag on the CLI invocation
   *   2. Tool config file on disk (read fresh every call — file may change)
   *   3. Known hardcoded default for the tool
   *
   * @param tool           The detected AITool
   * @param explicitModel  Value from `--model` flag, if present
   * @param cwd            Working directory — used for Aider's per-project config
   */
  resolve(tool: AITool, explicitModel?: string, cwd?: string): string {
    // 1. Explicit flag wins
    if (explicitModel && explicitModel.trim().length > 0) {
      return explicitModel.trim();
    }

    // 2. Config file
    const fromConfig = this.fromConfig(tool, cwd);
    if (fromConfig) return fromConfig;

    // 3. Default
    return DEFAULTS[tool] ?? 'unknown';
  }

  /**
   * Like resolve() but returns null instead of the hardcoded default when no
   * config-derived model is found. Use this in contexts where SQLite / config
   * files may not be accessible (e.g. VS Code extension sandbox) so that callers
   * can store `undefined` instead of a potentially wrong fallback.
   */
  resolveOrNull(tool: AITool, explicitModel?: string, cwd?: string): string | null {
    if (explicitModel && explicitModel.trim().length > 0) return explicitModel.trim();
    return this.fromConfig(tool, cwd);
  }

  private fromConfig(tool: AITool, cwd?: string): string | null {
    const home = os.homedir();

    switch (tool) {
      // ── Claude Code ──────────────────────────────────────────────────────
      case AITool.CLAUDE_CODE:
      case AITool.CLAUDE_CODE_AGENT: {
        const json = readJson(path.join(home, '.claude', 'settings.json'));
        return json ? str(json, 'model') : null;
      }

      // ── Cursor ───────────────────────────────────────────────────────────
      case AITool.CURSOR:
      case AITool.CURSOR_AGENT: {
        const mcp = readJson(path.join(home, '.cursor', 'mcp.json'));
        if (mcp) { const v = str(mcp, 'model'); if (v) return v; }
        const settings = readJson(path.join(home, '.cursor', 'settings.json'));
        return settings ? str(settings, 'model') : null;
      }

      // ── GitHub Copilot ───────────────────────────────────────────────────
      case AITool.COPILOT:
      case AITool.COPILOT_AGENT:
      case AITool.COPILOT_CLI: {
        // Read from VS Code state DB first (accurate, reflects UI selection)
        const fromState = resolveCopilotModel();
        if (fromState) return fromState;
        // Fallback: legacy settings.json key (older Copilot versions)
        const json = readJson(vsCodeSettingsPath());
        return json ? str(json, 'github.copilot.advanced.model') : null;
      }

      // ── Codeium ──────────────────────────────────────────────────────────
      case AITool.CODEIUM: {
        const json = readJson(path.join(home, '.codeium', 'config.json'));
        return json ? str(json, 'model') : null;
      }

      // ── Cline ────────────────────────────────────────────────────────────
      case AITool.CLINE: {
        const json = readJson(vsCodeSettingsPath());
        return json ? str(json, 'cline.apiModelId') : null;
      }

      // ── Aider ────────────────────────────────────────────────────────────
      case AITool.AIDER: {
        // Check project-local config first, then user home
        if (cwd) {
          const local = readAiderYml(path.join(cwd, '.aider.conf.yml'));
          if (local) return local;
        }
        return readAiderYml(path.join(home, '.aider.conf.yml'));
      }

      // ── Continue ─────────────────────────────────────────────────────────
      case AITool.CONTINUE: {
        const json = readJson(path.join(home, '.continue', 'config.json'));
        return json ? deepGet(json, 'models.0.model') : null;
      }

      // ── Codex CLI ──────────────────────────────────────────────────────
      case AITool.CODEX_CLI: {
        const json = readJson(path.join(home, '.codex', 'config.json'));
        return json ? str(json, 'model') : null;
      }

      default:
        return null;
    }
  }
}
