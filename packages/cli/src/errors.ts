import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Thrown by command handlers instead of calling process.exit().
 * Caught by the CLI entry point which owns all process.exit() calls.
 */
export class BrelaExit extends Error {
  constructor(
    public readonly code: number,
    message = '',
  ) {
    super(message);
    this.name = 'BrelaExit';
  }
}

/**
 * Appends a timestamped error line to .brela/errors.log.
 * Never throws — if the write fails, the error is silently dropped.
 */
export function logError(projectRoot: string, err: unknown): void {
  try {
    const logPath = path.join(projectRoot, '.brela', 'errors.log');
    const line = `[${new Date().toISOString()}] ${String(err)}\n`;
    fs.appendFileSync(logPath, line, 'utf8');
  } catch {
    // Truly silent — never let error logging cause a crash
  }
}
