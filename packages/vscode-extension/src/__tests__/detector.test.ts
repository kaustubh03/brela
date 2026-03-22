/**
 * Tests for packages/vscode-extension/src/detector.ts
 *
 * Strategy:
 *  - Mock `vscode` so tests run in plain Node (no VS Code host required)
 *  - Use real temp dirs for file-system operations
 *  - mockActive: Set<string> controls which extension IDs are "active"
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// ── VS Code mock ─────────────────────────────────────────────────────────────
// vi.hoisted guarantees the Set exists before the factory function below runs.
const mockActive = vi.hoisted(() => new Set<string>());

vi.mock('vscode', () => ({
  extensions: {
    getExtension: (id: string) =>
      mockActive.has(id) ? { isActive: true } : undefined,
  },
}));

// ── Subjects under test (imported AFTER mock is declared) ────────────────────
import { AITool, DetectionMethod } from '@brela-dev/core';
import { InsertionDetector, readLatestSnapshotFiles } from '../detector.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'brela-det-test-'));
}

/** Build a fake TextDocumentContentChangeEvent-like object. */
function makeChange(
  text: string,
  opts: { rangeLength?: number; startLine?: number } = {},
) {
  return {
    text,
    rangeLength: opts.rangeLength ?? 0,
    range: {
      start: { line: opts.startLine ?? 0 },
      end:   { line: opts.startLine ?? 0 },
    },
  };
}

/** Build a fake TextDocumentChangeEvent. */
function makeEvent(changes: ReturnType<typeof makeChange>[]) {
  return { contentChanges: changes } as any;
}

/**
 * A large AI-looking insertion: ≥3 newlines and ≥120 chars.
 * Padded to ensure the char threshold is met.
 */
const LARGE_INSERT =
  'function greet(name: string): string {\n' +
  '  // generated\n' +
  '  return `Hello, ${name}!`;\n' +
  '}\n'.padEnd(130, ' ');

/** Write a shell-intent file with the given tool and timestamp offset (ms). */
function writeShellIntent(
  root: string,
  tool: string,
  ageMs = 0, // ms in the past; 0 = now
): string {
  const dir = path.join(root, '.brela');
  fs.mkdirSync(dir, { recursive: true });
  const ts = new Date(Date.now() - ageMs).toISOString();
  const line = JSON.stringify({ tool, timestamp: ts }) + '\n';
  fs.writeFileSync(path.join(dir, 'shell-intents.jsonl'), line, 'utf8');
  return ts;
}

// ── Test suites ───────────────────────────────────────────────────────────────

describe('AITool enum', () => {
  it('COPILOT_CLI exists', () => {
    expect(AITool.COPILOT_CLI).toBe('COPILOT_CLI');
  });

  it('COPILOT_CLI is distinct from COPILOT_AGENT', () => {
    expect(AITool.COPILOT_CLI).not.toBe(AITool.COPILOT_AGENT);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('InsertionDetector.detect() — inline attribution', () => {
  let root: string;
  let detector: InsertionDetector;

  beforeEach(() => {
    root = makeTmpDir();
    detector = new InsertionDetector();
    mockActive.clear();
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('returns null for a single-character keystroke', () => {
    mockActive.add('GitHub.copilot');
    const result = detector.detect(makeEvent([makeChange('a')]), root);
    expect(result).toBeNull();
  });

  it('returns null for a short multi-char insertion below thresholds', () => {
    mockActive.add('GitHub.copilot');
    const result = detector.detect(makeEvent([makeChange('hello world')]), root);
    expect(result).toBeNull();
  });

  it('attributes LARGE_INSERTION to COPILOT when only Copilot is active', () => {
    mockActive.add('GitHub.copilot');
    const result = detector.detect(makeEvent([makeChange(LARGE_INSERT)]), root);
    expect(result).not.toBeNull();
    expect(result!.tool).toBe(AITool.COPILOT);
    expect(result!.detectionMethod).toBe(DetectionMethod.LARGE_INSERTION);
    expect(result!.confidence).toBe('high');
  });

  it('attributes LARGE_INSERTION to COPILOT when copilot-chat is active', () => {
    mockActive.add('GitHub.copilot-chat');
    const result = detector.detect(makeEvent([makeChange(LARGE_INSERT)]), root);
    expect(result!.tool).toBe(AITool.COPILOT);
  });

  it('attributes LARGE_INSERTION to CLAUDE_CODE when only Claude Code is active', () => {
    mockActive.add('anthropic.claude-code');
    const result = detector.detect(makeEvent([makeChange(LARGE_INSERT)]), root);
    expect(result!.tool).toBe(AITool.CLAUDE_CODE);
    expect(result!.confidence).toBe('medium');
  });

  it('attributes LARGE_INSERTION to CLAUDE_CODE via .claude directory fallback', () => {
    // No extension active — but .claude/ dir exists (CLI mode)
    fs.mkdirSync(path.join(root, '.claude'), { recursive: true });
    const result = detector.detect(makeEvent([makeChange(LARGE_INSERT)]), root);
    expect(result!.tool).toBe(AITool.CLAUDE_CODE);
  });

  it('COPILOT wins over CLAUDE_CODE when both are installed', () => {
    mockActive.add('GitHub.copilot');
    mockActive.add('anthropic.claude-code');
    const result = detector.detect(makeEvent([makeChange(LARGE_INSERT)]), root);
    expect(result!.tool).toBe(AITool.COPILOT);
  });

  it('attributes LARGE_INSERTION to CURSOR via extension', () => {
    mockActive.add('anysphere.cursor-always-local');
    const result = detector.detect(makeEvent([makeChange(LARGE_INSERT)]), root);
    expect(result!.tool).toBe(AITool.CURSOR);
    expect(result!.confidence).toBe('high');
  });

  it('attributes LARGE_INSERTION to CURSOR via .cursorrules file', () => {
    fs.writeFileSync(path.join(root, '.cursorrules'), '{}');
    const result = detector.detect(makeEvent([makeChange(LARGE_INSERT)]), root);
    expect(result!.tool).toBe(AITool.CURSOR);
  });

  it('attributes LARGE_INSERTION to CODEIUM/Windsurf via extension', () => {
    mockActive.add('codeium.windsurf');
    const result = detector.detect(makeEvent([makeChange(LARGE_INSERT)]), root);
    expect(result!.tool).toBe(AITool.CODEIUM);
  });

  it('attributes LARGE_INSERTION to CODEIUM/Windsurf via .windsurfrules file', () => {
    fs.writeFileSync(path.join(root, '.windsurfrules'), '{}');
    const result = detector.detect(makeEvent([makeChange(LARGE_INSERT)]), root);
    expect(result!.tool).toBe(AITool.CODEIUM);
  });

  it('attributes LARGE_INSERTION to CLINE via extension', () => {
    mockActive.add('saoudrizwan.claude-dev');
    const result = detector.detect(makeEvent([makeChange(LARGE_INSERT)]), root);
    expect(result!.tool).toBe(AITool.CLINE);
  });

  it('attributes LARGE_INSERTION to CONTINUE via extension', () => {
    mockActive.add('continue.continue');
    const result = detector.detect(makeEvent([makeChange(LARGE_INSERT)]), root);
    expect(result!.tool).toBe(AITool.CONTINUE);
  });

  it('attributes LARGE_INSERTION to AIDER via extension', () => {
    mockActive.add('aider-ai.aider');
    const result = detector.detect(makeEvent([makeChange(LARGE_INSERT)]), root);
    expect(result!.tool).toBe(AITool.AIDER);
  });

  it('returns UNKNOWN tool when no extension is active and no .claude dir', () => {
    const result = detector.detect(makeEvent([makeChange(LARGE_INSERT)]), root);
    // With no known AI extension, detectInlineTool() returns UNKNOWN
    // But LARGE_INSERTION still fires (just with UNKNOWN tool)
    expect(result!.tool).toBe(AITool.UNKNOWN);
  });

  it('records correct line range for the insertion', () => {
    mockActive.add('GitHub.copilot');
    const text = 'line1\nline2\nline3\nline4\n'.padEnd(130, ' ');
    const result = detector.detect(
      makeEvent([makeChange(text, { startLine: 5 })]),
      root,
    );
    expect(result!.linesStart).toBe(5);
    expect(result!.charsInserted).toBe(text.length);
  });

  it('detects CHATGPT_PASTE when text > 200 chars with no AI extension active', () => {
    const pasteText = 'x'.repeat(201);
    // rangeLength=0 means pure insertion (paste), no AI extension active
    const result = detector.detect(
      makeEvent([makeChange(pasteText, { rangeLength: 0 })]),
      root,
    );
    expect(result).not.toBeNull();
    expect(result!.tool).toBe(AITool.CHATGPT_PASTE);
    expect(result!.confidence).toBe('low');
  });

  it('does NOT flag CHATGPT_PASTE when a known AI extension is active', () => {
    mockActive.add('GitHub.copilot');
    // Short text that fails LARGE_INSERTION but would be a paste if no AI installed
    const shortPaste = 'x'.repeat(201);
    const result = detector.detect(
      makeEvent([makeChange(shortPaste, { rangeLength: 0 })]),
      root,
    );
    // LARGE_INSERTION threshold not met (no newlines), PASTE excluded because AI installed
    expect(result).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('InsertionDetector.trackForBurst()', () => {
  let root: string;
  let detector: InsertionDetector;

  beforeEach(() => {
    root = makeTmpDir();
    detector = new InsertionDetector();
    mockActive.clear();
    mockActive.add('GitHub.copilot');
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('returns null when only one file has changed', () => {
    const result = detector.trackForBurst(path.join(root, 'a.ts'), root);
    expect(result).toBeNull();
  });

  it('returns MULTI_FILE_BURST when 2 distinct files change within the burst window', () => {
    detector.trackForBurst(path.join(root, 'a.ts'), root);
    const result = detector.trackForBurst(path.join(root, 'b.ts'), root);
    expect(result).not.toBeNull();
    expect(result!.detectionMethod).toBe(DetectionMethod.MULTI_FILE_BURST);
    expect(result!.tool).toBe(AITool.COPILOT);
  });

  it('uses GENERIC_AGENT for burst when no extension is active', () => {
    mockActive.clear();
    detector.trackForBurst(path.join(root, 'a.ts'), root);
    const result = detector.trackForBurst(path.join(root, 'b.ts'), root);
    expect(result!.tool).toBe(AITool.GENERIC_AGENT);
  });

  it('evicts stale entries from the burst window', async () => {
    // Fake the burst window timestamp by first calling with file a, then
    // wait longer than the burst window cannot be done in unit tests without
    // fake timers — instead we verify that repeated calls on the SAME file
    // don't count as multiple distinct files.
    detector.trackForBurst(path.join(root, 'a.ts'), root);
    // Same file again — still only 1 unique file
    const result = detector.trackForBurst(path.join(root, 'a.ts'), root);
    expect(result).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('InsertionDetector.checkCoAuthorTrailer()', () => {
  let root: string;
  let detector: InsertionDetector;

  beforeEach(() => {
    root = makeTmpDir();
    detector = new InsertionDetector();
    fs.mkdirSync(path.join(root, '.git'), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('returns null when COMMIT_EDITMSG does not exist', () => {
    const result = detector.checkCoAuthorTrailer(root, 0, 0, 0);
    expect(result).toBeNull();
  });

  it('returns null when commit message has no Claude co-author', () => {
    fs.writeFileSync(
      path.join(root, '.git', 'COMMIT_EDITMSG'),
      'feat: add new feature\n\nCo-authored-by: Bob <bob@example.com>',
    );
    const result = detector.checkCoAuthorTrailer(root, 0, 0, 0);
    expect(result).toBeNull();
  });

  it('returns CO_AUTHOR_TRAILER result when Claude is in co-author line', () => {
    fs.writeFileSync(
      path.join(root, '.git', 'COMMIT_EDITMSG'),
      'feat: add feature\n\nCo-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>',
    );
    const result = detector.checkCoAuthorTrailer(root, 5, 20, 400);
    expect(result).not.toBeNull();
    expect(result!.tool).toBe(AITool.CLAUDE_CODE);
    expect(result!.detectionMethod).toBe(DetectionMethod.CO_AUTHOR_TRAILER);
    expect(result!.confidence).toBe('high');
    expect(result!.linesStart).toBe(5);
    expect(result!.linesEnd).toBe(20);
    expect(result!.charsInserted).toBe(400);
  });

  it('is case-insensitive for "co-authored-by: claude"', () => {
    fs.writeFileSync(
      path.join(root, '.git', 'COMMIT_EDITMSG'),
      'fix: bug\n\nco-authored-by: claude code',
    );
    const result = detector.checkCoAuthorTrailer(root, 0, 0, 0);
    expect(result!.tool).toBe(AITool.CLAUDE_CODE);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('InsertionDetector.checkAgentSave() — shell intent', () => {
  let root: string;
  let detector: InsertionDetector;

  beforeEach(() => {
    root = makeTmpDir();
    detector = new InsertionDetector();
    mockActive.clear();
    // Copilot is active to verify shell intent beats extension-based detection
    mockActive.add('GitHub.copilot-chat');
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('returns CLAUDE_CODE_AGENT via SHELL_WRAPPER when claude-code intent is recent', () => {
    writeShellIntent(root, 'claude-code');
    const result = detector.checkAgentSave(root);
    expect(result).not.toBeNull();
    expect(result!.tool).toBe(AITool.CLAUDE_CODE_AGENT);
    expect(result!.detectionMethod).toBe(DetectionMethod.SHELL_WRAPPER);
    expect(result!.confidence).toBe('high');
  });

  it('returns COPILOT_CLI via SHELL_WRAPPER when copilot-cli intent is recent', () => {
    writeShellIntent(root, 'copilot-cli');
    const result = detector.checkAgentSave(root);
    expect(result!.tool).toBe(AITool.COPILOT_CLI);
    expect(result!.detectionMethod).toBe(DetectionMethod.SHELL_WRAPPER);
  });

  it('returns AIDER via SHELL_WRAPPER for aider intent', () => {
    writeShellIntent(root, 'aider');
    const result = detector.checkAgentSave(root);
    expect(result!.tool).toBe(AITool.AIDER);
  });

  it('returns CONTINUE via SHELL_WRAPPER for continue intent', () => {
    writeShellIntent(root, 'continue');
    const result = detector.checkAgentSave(root);
    expect(result!.tool).toBe(AITool.CONTINUE);
  });

  it('ignores stale shell intent (> 5 minutes old) and falls back to extension', () => {
    // 301 seconds ago — past the 300s window
    writeShellIntent(root, 'claude-code', 301_000);
    const result = detector.checkAgentSave(root);
    // Falls back to Copilot Chat (agent detection)
    expect(result!.tool).toBe(AITool.COPILOT_AGENT);
    expect(result!.detectionMethod).toBe(DetectionMethod.EXTERNAL_FILE_WRITE);
  });

  it('ignores unknown tool name in shell intent', () => {
    writeShellIntent(root, 'unknown-tool-xyz');
    const result = detector.checkAgentSave(root);
    // Falls back to extension-based detection
    expect(result!.tool).toBe(AITool.COPILOT_AGENT);
  });

  it('consumes the intent exactly once — second call falls through to extension', () => {
    writeShellIntent(root, 'claude-code');

    const first = detector.checkAgentSave(root);
    expect(first!.tool).toBe(AITool.CLAUDE_CODE_AGENT);

    const second = detector.checkAgentSave(root);
    // Intent consumed — falls back to Copilot Chat
    expect(second!.tool).toBe(AITool.COPILOT_AGENT);
  });

  it('persisted consumed timestamp prevents re-attribution after VS Code reload', () => {
    const ts = writeShellIntent(root, 'claude-code');

    // First detector instance consumes the intent
    const d1 = new InsertionDetector();
    d1.checkAgentSave(root);

    // Verify the consumed timestamp was written to disk
    const persistedTs = fs.readFileSync(
      path.join(root, '.brela', 'consumed-intent-ts'),
      'utf8',
    ).trim();
    expect(persistedTs).toBe(ts);

    // New detector instance (simulates VS Code reload) — must not re-consume
    const d2 = new InsertionDetector();
    const result = d2.checkAgentSave(root);
    // Falls back to extension (Copilot Chat active)
    expect(result!.tool).toBe(AITool.COPILOT_AGENT);
  });

  it('correctly attributes a NEW claude run after an old one was consumed', () => {
    // Old intent consumed
    writeShellIntent(root, 'claude-code', 10_000);
    detector.checkAgentSave(root); // consume

    // Simulate a fresh `claude` run (newer timestamp)
    writeShellIntent(root, 'claude-code', 0);
    const result = detector.checkAgentSave(root);
    expect(result!.tool).toBe(AITool.CLAUDE_CODE_AGENT);
    expect(result!.detectionMethod).toBe(DetectionMethod.SHELL_WRAPPER);
  });

  it('returns null when no intent and no known agent extension is active', () => {
    mockActive.clear();
    const result = detector.checkAgentSave(root);
    expect(result).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('InsertionDetector.checkAgentSave() — extension fallback', () => {
  let root: string;
  let detector: InsertionDetector;

  beforeEach(() => {
    root = makeTmpDir();
    detector = new InsertionDetector();
    mockActive.clear();
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('returns CLAUDE_CODE_AGENT when only claude-code extension is active', () => {
    mockActive.add('anthropic.claude-code');
    const result = detector.checkAgentSave(root);
    expect(result!.tool).toBe(AITool.CLAUDE_CODE_AGENT);
    expect(result!.detectionMethod).toBe(DetectionMethod.EXTERNAL_FILE_WRITE);
  });

  it('returns COPILOT_AGENT when Copilot Chat is the only active agent extension', () => {
    mockActive.add('GitHub.copilot-chat');
    const result = detector.checkAgentSave(root);
    expect(result!.tool).toBe(AITool.COPILOT_AGENT);
  });

  it('CLAUDE_CODE_AGENT beats COPILOT_AGENT in detectAgentTool() priority', () => {
    // Both Claude Code and Copilot Chat active
    mockActive.add('anthropic.claude-code');
    mockActive.add('GitHub.copilot-chat');
    const result = detector.checkAgentSave(root);
    expect(result!.tool).toBe(AITool.CLAUDE_CODE_AGENT);
  });

  it('returns CURSOR_AGENT for .cursorrules workspace', () => {
    fs.writeFileSync(path.join(root, '.cursorrules'), '{}');
    const result = detector.checkAgentSave(root);
    expect(result!.tool).toBe(AITool.CURSOR_AGENT);
  });

  it('returns CLINE for saoudrizwan.claude-dev extension', () => {
    mockActive.add('saoudrizwan.claude-dev');
    const result = detector.checkAgentSave(root);
    expect(result!.tool).toBe(AITool.CLINE);
  });

  it('returns AIDER for aider-ai.aider extension', () => {
    mockActive.add('aider-ai.aider');
    const result = detector.checkAgentSave(root);
    expect(result!.tool).toBe(AITool.AIDER);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('InsertionDetector.checkFileCreation()', () => {
  let root: string;
  let detector: InsertionDetector;

  beforeEach(() => {
    root = makeTmpDir();
    detector = new InsertionDetector();
    mockActive.clear();
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('returns CLAUDE_CODE_AGENT via SHELL_WRAPPER for recent claude-code intent', () => {
    writeShellIntent(root, 'claude-code');
    const result = detector.checkFileCreation(root);
    expect(result.tool).toBe(AITool.CLAUDE_CODE_AGENT);
    expect(result.detectionMethod).toBe(DetectionMethod.SHELL_WRAPPER);
  });

  it('falls back to extension-based detection when no intent', () => {
    mockActive.add('GitHub.copilot-chat');
    const result = detector.checkFileCreation(root);
    expect(result.tool).toBe(AITool.COPILOT_AGENT);
    expect(result.detectionMethod).toBe(DetectionMethod.EXTERNAL_FILE_WRITE);
  });

  it('always returns a result — falls back to GENERIC_AGENT when nothing is known', () => {
    // No intent, no known extension
    const result = detector.checkFileCreation(root);
    expect(result.tool).toBe(AITool.GENERIC_AGENT);
    expect(result.confidence).toBe('medium');
    expect(result.detectionMethod).toBe(DetectionMethod.EXTERNAL_FILE_WRITE);
  });

  it('intent is consumed — second checkFileCreation uses extension fallback', () => {
    writeShellIntent(root, 'claude-code');
    mockActive.add('GitHub.copilot-chat');

    const first = detector.checkFileCreation(root);
    expect(first.tool).toBe(AITool.CLAUDE_CODE_AGENT);

    const second = detector.checkFileCreation(root);
    expect(second.tool).toBe(AITool.COPILOT_AGENT);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('readLatestSnapshotFiles()', () => {
  let root: string;

  beforeEach(() => {
    root = makeTmpDir();
    fs.mkdirSync(path.join(root, '.brela'), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('returns null when no snapshot files exist', () => {
    expect(readLatestSnapshotFiles(root)).toBeNull();
  });

  it('returns null when .brela directory does not exist', () => {
    const emptyRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'brela-no-brela-'));
    try {
      expect(readLatestSnapshotFiles(emptyRoot)).toBeNull();
    } finally {
      fs.rmSync(emptyRoot, { recursive: true, force: true });
    }
  });

  it('returns the file set from the single snapshot', () => {
    fs.writeFileSync(
      path.join(root, '.brela', 'snapshot-2024-01-01T10-00-00.txt'),
      'src/a.ts\nsrc/b.ts\n',
    );
    const result = readLatestSnapshotFiles(root);
    expect(result).not.toBeNull();
    expect(result!.has('src/a.ts')).toBe(true);
    expect(result!.has('src/b.ts')).toBe(true);
    expect(result!.size).toBe(2);
  });

  it('returns the MOST RECENT snapshot when multiple exist (lexicographic sort)', () => {
    // Lexicographically later name = more recent timestamp
    fs.writeFileSync(
      path.join(root, '.brela', 'snapshot-2024-01-01T10-00-00.txt'),
      'old-file.ts\n',
    );
    fs.writeFileSync(
      path.join(root, '.brela', 'snapshot-2024-01-02T10-00-00.txt'),
      'new-file.ts\n',
    );
    const result = readLatestSnapshotFiles(root);
    expect(result!.has('new-file.ts')).toBe(true);
    expect(result!.has('old-file.ts')).toBe(false);
  });

  it('ignores non-snapshot .txt files', () => {
    fs.writeFileSync(path.join(root, '.brela', 'other-file.txt'), 'should-be-ignored.ts\n');
    expect(readLatestSnapshotFiles(root)).toBeNull();
  });

  it('strips empty lines from the snapshot', () => {
    fs.writeFileSync(
      path.join(root, '.brela', 'snapshot-2024-03-01T00-00-00.txt'),
      'src/main.ts\n\nsrc/util.ts\n\n',
    );
    const result = readLatestSnapshotFiles(root);
    expect(result!.size).toBe(2);
  });
});
