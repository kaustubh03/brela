import * as fs from 'node:fs';
import * as path from 'node:path';
import type { TextDocumentChangeEvent } from 'vscode';
import { extensions } from 'vscode';
import { AITool, DetectionMethod } from '@brela-dev/core';

export interface DetectionResult {
  tool: AITool;
  confidence: 'high' | 'medium' | 'low';
  detectionMethod: DetectionMethod;
  linesStart: number;
  linesEnd: number;
  charsInserted: number;
}

// ── Threshold constants ────────────────────────────────────────────────────────
const LARGE_INSERTION_MIN_NEWLINES = 3;
const LARGE_INSERTION_MIN_CHARS    = 120;
const PASTE_HEURISTIC_MIN_CHARS    = 200;
const HUMAN_TYPING_DEBOUNCE_MS     = 50;
const MULTI_FILE_BURST_WINDOW_MS   = 2000;
const MULTI_FILE_BURST_MIN_FILES   = 2;
const SHELL_INTENT_WINDOW_MS       = 300_000; // 5 minutes — engineers context-switch after running claude

// ── Shell intent tool-name → AITool ───────────────────────────────────────────
const SHELL_INTENT_TOOL_MAP: Record<string, AITool> = {
  'claude-code': AITool.CLAUDE_CODE_AGENT,
  'copilot-cli': AITool.COPILOT_CLI,
  'aider':       AITool.AIDER,
  'continue':    AITool.CONTINUE,
  'codex-cli':   AITool.CODEX_CLI,
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function isExtensionActive(id: string): boolean {
  const ext = extensions.getExtension(id);
  return ext !== undefined && ext.isActive;
}

function hasCursorrules(workspaceRoot: string): boolean {
  return fs.existsSync(path.join(workspaceRoot, '.cursorrules'));
}

/**
 * Windsurf (Codeium's VS Code fork) runs its own built-in Cascade agent.
 * Detects via the windsurf-specific extension IDs or a .windsurfrules file.
 */
function hasWindsurf(workspaceRoot: string): boolean {
  return (
    isExtensionActive('codeium.windsurf') ||
    isExtensionActive('Codeium.windsurf-nightly') ||
    fs.existsSync(path.join(workspaceRoot, '.windsurfrules'))
  );
}

/**
 * True when Claude Code is actively running in VS Code.
 * Uses isActive (not just installed) so Copilot completions in a non-Claude
 * session don't get misattributed.
 * Falls back to .claude/ dir for workspaces where the CLI (not the extension)
 * is the active agent.
 */
function hasClaudeCode(workspaceRoot: string): boolean {
  return (
    isExtensionActive('anthropic.claude-code') ||
    fs.existsSync(path.join(workspaceRoot, '.claude'))
  );
}

/**
 * Detect the active AI tool for inline text-change events.
 * GitHub.copilot and GitHub.copilot-chat both map to COPILOT here because
 * the chat extension is also active during inline completions.
 */
function detectInlineTool(workspaceRoot: string): { tool: AITool; confidence: 'high' | 'medium' } {
  // Copilot is checked BEFORE Claude Code because when both are installed,
  // inline completions are ambiguous — Copilot wins to avoid false positives.
  // Claude Code-only installs fall through to the hasClaudeCode() fallback below.
  if (isExtensionActive('GitHub.copilot') || isExtensionActive('GitHub.copilot-chat')) {
    return { tool: AITool.COPILOT, confidence: 'high' };
  }
  if (isExtensionActive('anysphere.cursor-always-local') || hasCursorrules(workspaceRoot)) {
    return { tool: AITool.CURSOR, confidence: 'high' };
  }
  if (hasWindsurf(workspaceRoot)) {
    return { tool: AITool.CODEIUM, confidence: 'high' };
  }
  if (isExtensionActive('saoudrizwan.claude-dev')) {
    return { tool: AITool.CLINE, confidence: 'high' };
  }
  if (isExtensionActive('continue.continue')) {
    return { tool: AITool.CONTINUE, confidence: 'high' };
  }
  if (isExtensionActive('aider-ai.aider')) {
    return { tool: AITool.AIDER, confidence: 'high' };
  }
  if (isExtensionActive('Codeium.codeium')) {
    return { tool: AITool.CODEIUM, confidence: 'high' };
  }
  // Claude Code last: only wins when no competing inline tool is active.
  // Prevents false positives when Copilot is also installed.
  if (hasClaudeCode(workspaceRoot)) {
    return { tool: AITool.CLAUDE_CODE, confidence: 'medium' };
  }
  return { tool: AITool.UNKNOWN, confidence: 'medium' };
}

/**
 * Detect the active agent-mode AI tool for file saves / file creates.
 * Returns null if no known agent extension is active.
 *
 * Priority:
 *   anthropic.claude-code / .claude dir  → CLAUDE_CODE_AGENT
 *   GitHub.copilot-chat                  → COPILOT_AGENT
 *   Windsurf / .windsurfrules            → GENERIC_AGENT (Cascade)
 *   saoudrizwan.claude-dev               → CLINE
 *   continue.continue                    → CONTINUE
 *   anysphere / .cursorrules             → CURSOR_AGENT
 *   aider-ai.aider                       → AIDER
 */
function detectAgentTool(workspaceRoot: string): { tool: AITool; confidence: 'high' } | null {
  if (hasClaudeCode(workspaceRoot)) {
    return { tool: AITool.CLAUDE_CODE_AGENT, confidence: 'high' };
  }
  if (isExtensionActive('GitHub.copilot-chat')) {
    return { tool: AITool.COPILOT_AGENT, confidence: 'high' };
  }
  if (hasCodex(workspaceRoot)) {
    return { tool: AITool.CODEX_CLI, confidence: 'high' };
  }
  if (hasWindsurf(workspaceRoot)) {
    return { tool: AITool.GENERIC_AGENT, confidence: 'high' };
  }
  if (isExtensionActive('saoudrizwan.claude-dev')) {
    return { tool: AITool.CLINE, confidence: 'high' };
  }
  if (isExtensionActive('continue.continue')) {
    return { tool: AITool.CONTINUE, confidence: 'high' };
  }
  if (isExtensionActive('anysphere.cursor-always-local') || hasCursorrules(workspaceRoot)) {
    return { tool: AITool.CURSOR_AGENT, confidence: 'high' };
  }
  if (isExtensionActive('aider-ai.aider')) {
    return { tool: AITool.AIDER, confidence: 'high' };
  }
  return null;
}

/**
 * True when OpenAI Codex CLI has been used in this workspace.
 * Codex has no VS Code extension — detection relies on the .codex/ config
 * directory that Codex creates in the project root.
 *
 * Note: a .codex/ directory can persist after Codex is no longer in use, so
 * this is a lower-confidence signal than an active VS Code extension. It is
 * placed after extension-based checks (Copilot, Claude Code) in
 * detectAgentTool() so that real-time signals take priority.
 */
function hasCodex(workspaceRoot: string): boolean {
  try {
    return fs.statSync(path.join(workspaceRoot, '.codex')).isDirectory();
  } catch {
    return false;
  }
}

function hasKnownAIExtension(workspaceRoot: string): boolean {
  return detectInlineTool(workspaceRoot).tool !== AITool.UNKNOWN;
}

/**
 * Read the most recent entry from .brela/shell-intents.jsonl.
 * Returns the mapped AITool and its raw timestamp if logged within
 * SHELL_INTENT_WINDOW_MS. The timestamp is used by consumeIntent() to
 * prevent the same invocation from being attributed more than once.
 */
function readRecentShellIntent(workspaceRoot: string): { tool: AITool; timestamp: string } | null {
  try {
    const intentFile = path.join(workspaceRoot, '.brela', 'shell-intents.jsonl');
    if (!fs.existsSync(intentFile)) return null;
    const lines = fs.readFileSync(intentFile, 'utf8')
      .split('\n')
      .filter((l) => l.trim().length > 0);
    if (lines.length === 0) return null;
    const last = JSON.parse(lines[lines.length - 1]!) as { tool: string; timestamp: string };
    const age = Date.now() - new Date(last.timestamp).getTime();
    if (age > SHELL_INTENT_WINDOW_MS) return null;
    const tool = SHELL_INTENT_TOOL_MAP[last.tool];
    return tool !== undefined ? { tool, timestamp: last.timestamp } : null;
  } catch {
    return null;
  }
}

/**
 * Read the most recent snapshot-*.txt from .brela/ and return the set of
 * relative file paths listed in it, or null if no snapshot exists.
 * Used by extension.ts to filter agent-save attributions to only files
 * that Claude actually modified.
 */
export function readLatestSnapshotFiles(workspaceRoot: string): Set<string> | null {
  try {
    const brelaDir = path.join(workspaceRoot, '.brela');
    const snapshots = fs.readdirSync(brelaDir)
      .filter((f) => f.startsWith('snapshot-') && f.endsWith('.txt'))
      .sort()
      .reverse(); // most recent first
    if (snapshots.length === 0) return null;
    const content = fs.readFileSync(path.join(brelaDir, snapshots[0]!), 'utf8');
    const files = content.split('\n').filter(Boolean);
    return new Set(files);
  } catch {
    return null;
  }
}

// ── InsertionDetector ─────────────────────────────────────────────────────────

// Path to the file that persists the last consumed intent timestamp across reloads.
const CONSUMED_INTENT_FILE = '.brela/consumed-intent-ts';

export class InsertionDetector {
  private lastSingleCharAt = 0;
  /** filepath → timestamp, for multi-file burst detection */
  private readonly burstWindow = new Map<string, number>();
  /** In-memory cache of the persisted consumed timestamp */
  private lastConsumedIntentTimestamp: string | null = null;

  /** Read persisted consumed timestamp from disk (survives VS Code reloads). */
  private readPersistedConsumedTs(workspaceRoot: string): string | null {
    try {
      const f = path.join(workspaceRoot, CONSUMED_INTENT_FILE);
      if (!fs.existsSync(f)) return null;
      return fs.readFileSync(f, 'utf8').trim() || null;
    } catch {
      return null;
    }
  }

  /** Persist consumed timestamp to disk so reloads don't re-attribute old intents. */
  private persistConsumedTs(workspaceRoot: string, ts: string): void {
    try {
      fs.writeFileSync(path.join(workspaceRoot, CONSUMED_INTENT_FILE), ts, 'utf8');
    } catch {
      // Non-fatal — in-memory cache still prevents duplicates within this session
    }
    this.lastConsumedIntentTimestamp = ts;
  }

  /**
   * Read the most recent shell intent and consume it (once) so subsequent
   * saves don't re-attribute the same terminal invocation.
   * Checks both in-memory state and the persisted file so VS Code reloads
   * don't re-fire the same intent.
   */
  private consumeIntent(workspaceRoot: string): { tool: AITool } | null {
    const intent = readRecentShellIntent(workspaceRoot);
    if (intent === null) return null;

    // Resolve consumed timestamp: in-memory takes precedence, fall back to disk
    const consumedTs =
      this.lastConsumedIntentTimestamp ?? this.readPersistedConsumedTs(workspaceRoot);

    if (intent.timestamp === consumedTs) return null;

    this.persistConsumedTs(workspaceRoot, intent.timestamp);
    return { tool: intent.tool };
  }

  /**
   * Primary entry point for text-change events (Rules A & C).
   * Returns a DetectionResult if the change looks like an AI insertion,
   * or null if it looks like normal human typing.
   */
  detect(event: TextDocumentChangeEvent, workspaceRoot: string): DetectionResult | null {
    for (const change of event.contentChanges) {
      const result = this.evaluateChange(change, workspaceRoot);
      if (result !== null) return result;
    }
    return null;
  }

  /**
   * Track this file in the burst window, then check whether 2+ distinct files
   * have changed within MULTI_FILE_BURST_WINDOW_MS with no recent human typing.
   * Must be called for every onDidChangeTextDocument event so the window stays
   * accurate even when detect() already returned a result.
   */
  trackForBurst(fsPath: string, workspaceRoot: string): DetectionResult | null {
    const now = Date.now();
    this.burstWindow.set(fsPath, now);
    // Evict stale entries
    for (const [fp, ts] of this.burstWindow) {
      if (now - ts > MULTI_FILE_BURST_WINDOW_MS) this.burstWindow.delete(fp);
    }
    if (
      this.burstWindow.size >= MULTI_FILE_BURST_MIN_FILES &&
      now - this.lastSingleCharAt > HUMAN_TYPING_DEBOUNCE_MS
    ) {
      const { tool } = detectInlineTool(workspaceRoot);
      return {
        tool:              tool !== AITool.UNKNOWN ? tool : AITool.GENERIC_AGENT,
        confidence:        'medium',
        detectionMethod:   DetectionMethod.MULTI_FILE_BURST,
        linesStart:        0,
        linesEnd:          0,
        charsInserted:     0,
      };
    }
    return null;
  }

  private evaluateChange(
    change: { text: string; rangeLength: number; range: { start: { line: number }; end: { line: number } } },
    workspaceRoot: string,
  ): DetectionResult | null {
    const text = change.text;
    const len  = text.length;
    const now  = Date.now();

    // Track single-char keystrokes for debounce
    if (len === 1) {
      this.lastSingleCharAt = now;
      return null;
    }

    const newlineCount      = (text.match(/\n/g) ?? []).length;
    const msSinceLastChar   = now - this.lastSingleCharAt;
    const isRecentHumanTyping = msSinceLastChar < HUMAN_TYPING_DEBOUNCE_MS;

    // Rule A — LARGE_INSERTION
    // Shell intent is intentionally NOT consumed here. Inline text-change events
    // fire for both AI agents and Copilot completions — consuming the intent here
    // would misattribute Copilot edits made after a terminal `claude` run.
    // Intent consumption is reserved for checkAgentSave() and checkFileCreation()
    // which only fire for direct-to-disk writes (unambiguously agentic).
    if (
      newlineCount >= LARGE_INSERTION_MIN_NEWLINES &&
      len > LARGE_INSERTION_MIN_CHARS &&
      !isRecentHumanTyping
    ) {
      const { tool, confidence } = detectInlineTool(workspaceRoot);
      return {
        tool,
        confidence,
        detectionMethod: DetectionMethod.LARGE_INSERTION,
        linesStart:   change.range.start.line,
        linesEnd:     change.range.start.line + newlineCount,
        charsInserted: len,
      };
    }

    // Rule C — PASTE_HEURISTIC
    if (
      change.rangeLength === 0 &&
      len > PASTE_HEURISTIC_MIN_CHARS &&
      !hasKnownAIExtension(workspaceRoot)
    ) {
      return {
        tool:            AITool.CHATGPT_PASTE,
        confidence:      'low',
        detectionMethod: DetectionMethod.LARGE_INSERTION,
        linesStart:      change.range.start.line,
        linesEnd:        change.range.start.line + newlineCount,
        charsInserted:   len,
      };
    }

    return null;
  }

  /**
   * Agent save — file written directly to disk with no preceding text-change events.
   * Priority: shell intent (60 s) → known agent extension → null (skip).
   */
  checkAgentSave(workspaceRoot: string): DetectionResult | null {
    // Priority 1: shell intent (highest, consumed once per invocation)
    const intent = this.consumeIntent(workspaceRoot);
    if (intent !== null) {
      return {
        tool:            intent.tool,
        confidence:      'high',
        detectionMethod: DetectionMethod.SHELL_WRAPPER,
        linesStart: 0, linesEnd: 0, charsInserted: 0,
      };
    }
    // Priority 2: known agent extension
    const agentTool = detectAgentTool(workspaceRoot);
    if (agentTool === null) return null;
    return {
      tool:            agentTool.tool,
      confidence:      agentTool.confidence,
      detectionMethod: DetectionMethod.EXTERNAL_FILE_WRITE,
      linesStart: 0, linesEnd: 0, charsInserted: 0,
    };
  }

  /**
   * File creation — always returns a result (GENERIC_AGENT as final fallback).
   * Priority: shell intent (60 s) → known agent extension → GENERIC_AGENT medium.
   */
  checkFileCreation(workspaceRoot: string): DetectionResult {
    // Priority 1: shell intent (highest, consumed once per invocation)
    const intent = this.consumeIntent(workspaceRoot);
    if (intent !== null) {
      return {
        tool:            intent.tool,
        confidence:      'high',
        detectionMethod: DetectionMethod.SHELL_WRAPPER,
        linesStart: 0, linesEnd: 0, charsInserted: 0,
      };
    }
    // Priority 2: known agent extension
    const agentTool = detectAgentTool(workspaceRoot);
    if (agentTool !== null) {
      return {
        tool:            agentTool.tool,
        confidence:      agentTool.confidence,
        detectionMethod: DetectionMethod.EXTERNAL_FILE_WRITE,
        linesStart: 0, linesEnd: 0, charsInserted: 0,
      };
    }
    // Fallback: file creation always gets attributed
    return {
      tool:            AITool.GENERIC_AGENT,
      confidence:      'medium',
      detectionMethod: DetectionMethod.EXTERNAL_FILE_WRITE,
      linesStart: 0, linesEnd: 0, charsInserted: 0,
    };
  }

  /**
   * Rule B — CO_AUTHOR_TRAILER.
   * Called on file save. Reads .git/COMMIT_EDITMSG and returns a result
   * if the last commit credits Claude.
   */
  checkCoAuthorTrailer(
    workspaceRoot: string,
    linesStart: number,
    linesEnd: number,
    charsInserted: number,
  ): DetectionResult | null {
    // Data-driven: map co-author name substrings to tools. Checked in order;
    // easy to extend when new AI tools adopt the Co-Authored-By convention.
    const CO_AUTHOR_MAP: Array<[string, AITool]> = [
      ['claude', AITool.CLAUDE_CODE],
      ['codex',  AITool.CODEX_CLI],
    ];

    const msgPath = path.join(workspaceRoot, '.git', 'COMMIT_EDITMSG');
    try {
      if (!fs.existsSync(msgPath)) return null;
      const msg = fs.readFileSync(msgPath, 'utf8').toLowerCase();
      for (const [name, tool] of CO_AUTHOR_MAP) {
        if (msg.includes(`co-authored-by: ${name}`)) {
          return {
            tool,
            confidence:      'high',
            detectionMethod: DetectionMethod.CO_AUTHOR_TRAILER,
            linesStart,
            linesEnd,
            charsInserted,
          };
        }
      }
      return null;
    } catch {
      return null;
    }
  }
}
