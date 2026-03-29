import * as fs from 'node:fs';
import * as path from 'node:path';
import chokidar from 'chokidar';
import { SidecarWriter, SessionManager, AITool, DetectionMethod, ModelResolver } from '@brela-dev/core';
import type { AttributionEntry, BrelaConfig, LineRange } from '@brela-dev/core';

// ── Constants ────────────────────────────────────────────────────────────────

const BUFFER_TTL_MS = 60_000;
const INTENT_WINDOW_MS = 30_000;     // fallback: correlate live file-watcher events within 30s
const IDLE_PRUNE_INTERVAL_MS = 30_000;

// ── Logging (to .brela/daemon.log only) ───────────────────────────────────

let logStream: fs.WriteStream | null = null;

function initLog(projectRoot: string): void {
  const logPath = path.join(projectRoot, '.brela', 'daemon.log');
  logStream = fs.createWriteStream(logPath, { flags: 'a' });
}

function log(msg: string): void {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  logStream?.write(line);
}

// ── Intent log parsing ───────────────────────────────────────────────────────

interface ShellIntent {
  tool: string;
  args: string;
  timestamp: string;
  pwd: string;
}

/** Extract the value of `--model <value>` from a raw args string, or undefined. */
function parseModelFlag(args: string): string | undefined {
  const m = args.match(/--model\s+(\S+)/);
  return m?.[1];
}

function toolFromIntent(intentTool: string): AITool {
  if (intentTool === 'claude-code') return AITool.CLAUDE_CODE_AGENT;
  if (intentTool === 'copilot-cli') return AITool.COPILOT_CLI;
  if (intentTool === 'aider')       return AITool.AIDER;
  if (intentTool === 'continue')    return AITool.CONTINUE;
  if (intentTool === 'codex-cli')   return AITool.CODEX_CLI;
  return AITool.UNKNOWN;
}

function readRecentIntents(projectRoot: string, windowMs: number): ShellIntent[] {
  const intentFile = path.join(projectRoot, '.brela', 'shell-intents.jsonl');
  if (!fs.existsSync(intentFile)) return [];

  const cutoff = Date.now() - windowMs;
  const lines = fs.readFileSync(intentFile, 'utf8').split('\n');
  const recent: ShellIntent[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const intent = JSON.parse(trimmed) as ShellIntent;
      if (new Date(intent.timestamp).getTime() >= cutoff) {
        recent.push(intent);
      }
    } catch {
      // Malformed line — skip silently
    }
  }

  return recent;
}

// ── File buffer ──────────────────────────────────────────────────────────────

interface FileRecord {
  changedAt: number;
  sizeDeltas: number[];
  lastLineCount: number;
  lineRanges?: LineRange[]; // accumulated across all changes in this buffer window
}

class FileBuffer {
  private readonly records = new Map<string, FileRecord>();

  update(filePath: string, currentLineCount: number, newRanges?: LineRange[]): void {
    const existing = this.records.get(filePath);
    const prevLines = existing?.lastLineCount ?? currentLineCount;
    const delta = currentLineCount - prevLines;

    // Merge new ranges with any previously recorded ranges for this buffer window
    const merged: LineRange[] | undefined = newRanges
      ? [...(existing?.lineRanges ?? []), ...newRanges]
      : existing?.lineRanges;

    this.records.set(filePath, {
      changedAt: Date.now(),
      sizeDeltas: [...(existing?.sizeDeltas ?? []), delta],
      lastLineCount: currentLineCount,
      lineRanges: merged,
    });
  }

  recentFiles(windowMs: number): Array<{ filePath: string; record: FileRecord }> {
    const cutoff = Date.now() - windowMs;
    const results: Array<{ filePath: string; record: FileRecord }> = [];
    for (const [filePath, record] of this.records) {
      if (record.changedAt >= cutoff) {
        results.push({ filePath, record });
      }
    }
    return results;
  }

  prune(): void {
    const cutoff = Date.now() - BUFFER_TTL_MS;
    for (const [filePath, record] of this.records) {
      if (record.changedAt < cutoff) {
        this.records.delete(filePath);
      }
    }
  }
}

// ── Line counting ────────────────────────────────────────────────────────────

function countLines(filePath: string): number {
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    return content.split('\n').length;
  } catch {
    return 0;
  }
}

// ── Line-level diff ───────────────────────────────────────────────────────────

/**
 * Returns the line ranges (1-indexed, inclusive) in `after` that are newly
 * added compared to `before`. Uses a multiset approach: any line that appears
 * more times in `after` than `before` — or doesn't appear at all — is "added".
 * Consecutive added line numbers are merged into ranges.
 *
 * When `captureCode` is true, each range also stores the actual source lines
 * in `content` (newline-separated). Disable to avoid session file bloat.
 */
function extractAddedRanges(before: string, after: string, captureCode: boolean): LineRange[] {
  const beforeLines = before.split('\n');
  const afterLines  = after.split('\n');

  // Build multiset of before lines
  const pool = new Map<string, number>();
  for (const line of beforeLines) {
    pool.set(line, (pool.get(line) ?? 0) + 1);
  }

  // Walk after lines; consume from pool; anything left over is "added"
  const addedNums: number[] = [];
  for (let i = 0; i < afterLines.length; i++) {
    const line = afterLines[i]!;
    const remaining = pool.get(line) ?? 0;
    if (remaining > 0) {
      pool.set(line, remaining - 1);
    } else {
      addedNums.push(i + 1); // 1-indexed
    }
  }

  // Merge consecutive numbers into ranges, optionally attaching source content
  const ranges: LineRange[] = [];
  for (const n of addedNums) {
    const last = ranges[ranges.length - 1];
    if (last && n === last.end + 1) {
      last.end = n;
      if (captureCode && last.content !== undefined) {
        last.content += '\n' + (afterLines[n - 1] ?? '');
      }
    } else {
      const range: LineRange = { start: n, end: n };
      if (captureCode) range.content = afterLines[n - 1] ?? '';
      ranges.push(range);
    }
  }
  return ranges;
}

// ── Config reader ─────────────────────────────────────────────────────────────

function readConfig(projectRoot: string): BrelaConfig {
  const configFile = path.join(projectRoot, '.brela', 'config.json');
  if (!fs.existsSync(configFile)) return {};
  try {
    return JSON.parse(fs.readFileSync(configFile, 'utf8')) as BrelaConfig;
  } catch {
    return {};
  }
}

// ── File content cache ────────────────────────────────────────────────────────

const MAX_CACHED_FILES = 200;
const MAX_FILE_BYTES   = 512 * 1024; // skip files > 512 KB

// Source-code extensions worth caching
const SOURCE_EXTS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.py', '.rb', '.go', '.rs', '.java', '.kt', '.swift',
  '.c', '.cpp', '.h', '.hpp', '.cs', '.php',
  '.vue', '.svelte', '.html', '.css', '.scss', '.sass',
  '.json', '.yaml', '.yml', '.toml', '.md', '.mdx',
  '.sh', '.bash', '.zsh',
]);

class FileContentCache {
  // Ordered map: insertion order ≈ LRU (we re-insert on access)
  private readonly cache = new Map<string, string>();

  private isCacheable(filePath: string): boolean {
    const ext = path.extname(filePath).toLowerCase();
    if (!SOURCE_EXTS.has(ext)) return false;
    try {
      return fs.statSync(filePath).size <= MAX_FILE_BYTES;
    } catch {
      return false;
    }
  }

  /** Read and cache the current content of filePath. Returns content or null. */
  store(filePath: string): string | null {
    if (!this.isCacheable(filePath)) return null;
    try {
      const content = fs.readFileSync(filePath, 'utf8');
      // Evict oldest entries if over limit
      if (this.cache.size >= MAX_CACHED_FILES && !this.cache.has(filePath)) {
        const oldest = this.cache.keys().next().value;
        if (oldest !== undefined) this.cache.delete(oldest);
      }
      this.cache.set(filePath, content);
      return content;
    } catch {
      return null;
    }
  }

  /** Get cached content without updating. Returns null if not cached. */
  get(filePath: string): string | null {
    return this.cache.get(filePath) ?? null;
  }

  /** Evict a file from the cache (e.g. on delete). */
  evict(filePath: string): void {
    this.cache.delete(filePath);
  }
}

// ── Git guard ─────────────────────────────────────────────────────────────────

function hasGit(projectRoot: string): boolean {
  return fs.existsSync(path.join(projectRoot, '.git'));
}

// ── Attribution correlation ──────────────────────────────────────────────────

const modelResolver = new ModelResolver();

function correlate(
  filePath: string,
  record: FileRecord,
  intents: ShellIntent[],
  projectRoot: string,
  writer: SidecarWriter,
  session: SessionManager,
): void {
  if (intents.length === 0) return;

  // Use the most recent intent
  const intent = intents[intents.length - 1]!;
  const tool = toolFromIntent(intent.tool);

  // Resolve model: explicit --model flag > config file > default
  const explicitModel = parseModelFlag(intent.args);
  const model = modelResolver.resolve(tool, explicitModel, intent.pwd);

  const totalDelta = record.sizeDeltas.reduce((a, b) => a + b, 0);
  const linesEnd = record.lastLineCount;
  const linesStart = Math.max(0, linesEnd - Math.abs(totalDelta));

  // Rough chars-inserted estimate: assume ~50 chars per added line
  const charsInserted = Math.max(0, totalDelta) * 50;

  const relFile = filePath.startsWith(projectRoot)
    ? filePath.slice(projectRoot.length).replace(/^[\\/]/, '')
    : filePath;

  const entry: AttributionEntry = {
    file: relFile,
    tool,
    model,
    confidence: 'medium',
    detectionMethod: DetectionMethod.SHELL_WRAPPER,
    linesStart,
    linesEnd,
    ...(record.lineRanges && record.lineRanges.length > 0 ? { lineRanges: record.lineRanges } : {}),
    charsInserted,
    timestamp: new Date().toISOString(),
    sessionId: session.getCurrentSession(),
    accepted: true,
  };

  try {
    writer.write(entry);
    log(`attributed ${relFile} to ${tool} (${model}) via ${intent.tool} intent`);
  } catch (err) {
    log(`write error: ${String(err)}`);
  }
}

// ── Snapshot-based session attribution ───────────────────────────────────────

/**
 * Written by the shell hook after each AI command completes.
 * `changedFiles` is a pipe-separated list of absolute paths that were
 * newer than the marker file touched before the command started.
 */
interface CompletedShellSession {
  tool:         string;
  args:         string;
  timestamp:    string;
  pwd:          string;
  changedFiles: string; // e.g. "/repo/src/a.ts|/repo/src/b.ts|"
}

/**
 * Process any new lines in shell-sessions.jsonl that have not yet been
 * attributed.  Uses a byte-offset cursor so lines are never processed twice.
 */
function makeShellSessionProcessor(
  projectRoot: string,
  writer:       SidecarWriter,
  session:      SessionManager,
  contentCache: FileContentCache,
): () => void {
  let offset = 0;

  return function processNewSessions(): void {
    const sessionsFile = path.join(projectRoot, '.brela', 'shell-sessions.jsonl');
    if (!fs.existsSync(sessionsFile)) return;

    let raw: string;
    try {
      raw = fs.readFileSync(sessionsFile, 'utf8');
    } catch {
      return;
    }

    const newContent = raw.slice(offset);
    if (!newContent.trim()) return;
    offset = Buffer.byteLength(raw, 'utf8');

    for (const line of newContent.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let completed: CompletedShellSession;
      try {
        completed = JSON.parse(trimmed) as CompletedShellSession;
      } catch {
        continue; // malformed line
      }
      attributeShellSession(completed, projectRoot, writer, session, contentCache);
    }
  };
}

function attributeShellSession(
  completed:    CompletedShellSession,
  projectRoot:  string,
  writer:       SidecarWriter,
  session:      SessionManager,
  contentCache: FileContentCache,
): void {
  const filePaths = completed.changedFiles
    .split('|')
    .map(f => f.trim())
    .filter(f => f.length > 0);

  if (filePaths.length === 0) {
    log(`shell session from ${completed.tool} completed with no file changes`);
    return;
  }

  const tool          = toolFromIntent(completed.tool);
  const explicitModel = parseModelFlag(completed.args);
  const model         = modelResolver.resolve(tool, explicitModel, completed.pwd);
  const isMultiFile   = filePaths.length > 1;

  for (const filePath of filePaths) {
    const content   = contentCache.store(filePath) ?? '';
    const lineCount = content ? content.split('\n').length : countLines(filePath);

    const relFile = filePath.startsWith(projectRoot)
      ? filePath.slice(projectRoot.length).replace(/^[\\/]/, '')
      : filePath;

    const entry: AttributionEntry = {
      file:            relFile,
      tool,
      model,
      confidence:      'high', // snapshot-based: exact file list, no guessing
      detectionMethod: isMultiFile
        ? DetectionMethod.MULTI_FILE_BURST
        : DetectionMethod.SHELL_WRAPPER,
      linesStart:      1,
      linesEnd:        lineCount,
      charsInserted:   content.length,
      timestamp:       completed.timestamp,
      sessionId:       session.getCurrentSession(),
      accepted:        true,
    };

    try {
      writer.write(entry);
      log(`attributed ${relFile} to ${tool} (${model}) via completed shell session`);
    } catch (err) {
      log(`write error for ${relFile}: ${String(err)}`);
    }
  }
}

// ── Daemon main ──────────────────────────────────────────────────────────────

function main(): void {
  const projectRoot = process.argv[2];

  if (!projectRoot || !fs.existsSync(projectRoot)) {
    process.stderr.write('brela-daemon: project root not provided or does not exist\n');
    process.exit(1);
  }

  // Ensure .brela/ exists before any log/write operations
  fs.mkdirSync(path.join(projectRoot, '.brela'), { recursive: true });

  initLog(projectRoot);
  log(`daemon started — watching ${projectRoot}`);

  const config       = readConfig(projectRoot);
  const captureCode  = config.captureCode === true;
  const buffer       = new FileBuffer();
  const contentCache = new FileContentCache();
  const writer       = new SidecarWriter(projectRoot);
  const session      = new SessionManager(projectRoot);
  const gitAvailable = hasGit(projectRoot);

  log(`captureCode: ${captureCode} (edit .brela/config.json to toggle, then restart daemon)`);

  if (!gitAvailable) {
    log('no .git found — git operations disabled');
  }

  // ── Watcher setup ────────────────────────────────────────────────────────
  const watcher = chokidar.watch(projectRoot, {
    ignored: [
      /(^|[/\\])\.(git|brela)([/\\]|$)/,  // .git and .brela
      /node_modules/,
    ],
    ignoreInitial: false,        // fire 'add' for existing files to seed the cache
    persistent: true,
    usePolling: false,           // inotify/FSEvents — low CPU
    awaitWriteFinish: {
      stabilityThreshold: 100,   // wait 100ms after last write before firing
      pollInterval: 50,
    },
  });

  // Seed cache on startup — no attribution, just remember current content
  function handleAdd(filePath: string): void {
    contentCache.store(filePath);
  }

  function handleChange(filePath: string): void {
    try {
      // Capture before/after content for line-level diff
      const beforeContent = contentCache.get(filePath);
      const afterContent  = contentCache.store(filePath); // reads + caches new content

      let lineRanges: LineRange[] | undefined;
      if (afterContent !== null) {
        if (beforeContent === null) {
          // File seen for the first time on a change — treat all lines as new
          const lineCount = afterContent.split('\n').length;
          const range: LineRange = { start: 1, end: lineCount };
          if (captureCode) range.content = afterContent;
          lineRanges = [range];
        } else {
          const ranges = extractAddedRanges(beforeContent, afterContent, captureCode);
          if (ranges.length > 0) lineRanges = ranges;
        }
      }

      const lineCount = afterContent !== null
        ? afterContent.split('\n').length
        : countLines(filePath);

      buffer.update(filePath, lineCount, lineRanges);

      const intents = readRecentIntents(projectRoot, INTENT_WINDOW_MS);
      if (intents.length > 0) {
        const record = buffer.recentFiles(INTENT_WINDOW_MS)
          .find((r) => r.filePath === filePath);
        if (record !== undefined) {
          correlate(filePath, record.record, intents, projectRoot, writer, session);
        }
      }
    } catch (err) {
      log(`handleChange error for ${filePath}: ${String(err)}`);
    }
  }

  watcher.on('add',    handleAdd);
  watcher.on('change', handleChange);
  watcher.on('unlink', (filePath) => contentCache.evict(filePath));
  watcher.on('error',  (err) => log(`watcher error: ${String(err)}`));

  // ── Snapshot-based session watcher ────────────────────────────────────────
  // Watches shell-sessions.jsonl which the shell hook writes after each AI
  // command completes.  No time window — file list is exact.
  const processNewSessions = makeShellSessionProcessor(
    projectRoot, writer, session, contentCache,
  );

  const shellSessionsFile = path.join(projectRoot, '.brela', 'shell-sessions.jsonl');
  const sessionFileWatcher = chokidar.watch(shellSessionsFile, {
    ignoreInitial: false,
    persistent:    true,
    awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 50 },
  });
  sessionFileWatcher.on('add',    processNewSessions);
  sessionFileWatcher.on('change', processNewSessions);

  // ── Periodic buffer pruning (keeps RAM bounded) ──────────────────────────
  const pruneTimer = setInterval(() => {
    try {
      buffer.prune();
    } catch (err) {
      log(`prune error: ${String(err)}`);
    }
  }, IDLE_PRUNE_INTERVAL_MS);
  pruneTimer.unref(); // don't keep the process alive for pruning alone

  // ── Graceful shutdown ────────────────────────────────────────────────────
  function shutdown(signal: string): void {
    log(`daemon stopping (${signal})`);
    clearInterval(pruneTimer);
    Promise.allSettled([watcher.close(), sessionFileWatcher.close()]).then(() => {
      logStream?.end();
      process.exit(0);
    });
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main();
