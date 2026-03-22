import * as fs from 'node:fs';
import * as path from 'node:path';
import chokidar from 'chokidar';
import { SidecarWriter, SessionManager, AITool, DetectionMethod } from '@brela/core';
import type { AttributionEntry } from '@brela/core';

// ── Constants ────────────────────────────────────────────────────────────────

const BUFFER_TTL_MS = 60_000;        // drop file records older than 60s
const INTENT_WINDOW_MS = 30_000;     // correlate intents within 30s
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

function toolFromIntent(intentTool: string): AITool {
  if (intentTool === 'claude-code') return AITool.CLAUDE_CODE;
  if (intentTool === 'copilot-cli') return AITool.COPILOT;
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
}

class FileBuffer {
  private readonly records = new Map<string, FileRecord>();

  update(filePath: string, currentLineCount: number): void {
    const existing = this.records.get(filePath);
    const prevLines = existing?.lastLineCount ?? currentLineCount;
    const delta = currentLineCount - prevLines;

    this.records.set(filePath, {
      changedAt: Date.now(),
      sizeDeltas: [...(existing?.sizeDeltas ?? []), delta],
      lastLineCount: currentLineCount,
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

// ── Git guard ─────────────────────────────────────────────────────────────────

function hasGit(projectRoot: string): boolean {
  return fs.existsSync(path.join(projectRoot, '.git'));
}

// ── Attribution correlation ──────────────────────────────────────────────────

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
    confidence: 'medium',
    detectionMethod: DetectionMethod.SHELL_WRAPPER,
    linesStart,
    linesEnd,
    charsInserted,
    timestamp: new Date().toISOString(),
    sessionId: session.getCurrentSession(),
    accepted: true,
  };

  try {
    writer.write(entry);
    log(`attributed ${relFile} to ${tool} via ${intent.tool} intent`);
  } catch (err) {
    log(`write error: ${String(err)}`);
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

  const buffer = new FileBuffer();
  const writer = new SidecarWriter(projectRoot);
  const session = new SessionManager(projectRoot);
  const gitAvailable = hasGit(projectRoot);

  if (!gitAvailable) {
    log('no .git found — git operations disabled');
  }

  // ── Watcher setup ────────────────────────────────────────────────────────
  const watcher = chokidar.watch(projectRoot, {
    ignored: [
      /(^|[/\\])\.(git|brela)([/\\]|$)/,  // .git and .brela
      /node_modules/,
    ],
    ignoreInitial: true,         // don't fire for already-existing files
    persistent: true,
    usePolling: false,           // inotify/FSEvents — low CPU
    awaitWriteFinish: {
      stabilityThreshold: 100,   // wait 100ms after last write before firing
      pollInterval: 50,
    },
  });

  function handleChange(filePath: string): void {
    try {
      const lineCount = countLines(filePath);
      buffer.update(filePath, lineCount);

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

  watcher.on('add', handleChange);
  watcher.on('change', handleChange);
  watcher.on('error', (err) => log(`watcher error: ${String(err)}`));

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
    watcher.close().then(() => {
      logStream?.end();
      process.exit(0);
    }).catch(() => {
      logStream?.end();
      process.exit(0);
    });
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main();
