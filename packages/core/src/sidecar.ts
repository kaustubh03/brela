import * as fs from 'node:fs';
import * as path from 'node:path';
import type { AttributionEntry } from './types.js';

function toDateString(date: Date): string {
  return date.toISOString().slice(0, 10); // YYYY-MM-DD
}

function parseEntries(raw: string): AttributionEntry[] {
  return raw
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as AttributionEntry);
}

export class SidecarWriter {
  private readonly sessionsDir: string;

  constructor(projectRoot: string) {
    this.sessionsDir = path.join(projectRoot, '.brela', 'sessions');
  }

  private ensureDir(): void {
    fs.mkdirSync(this.sessionsDir, { recursive: true });
  }

  private sessionFile(dateStr: string): string {
    return path.join(this.sessionsDir, `${dateStr}.json`);
  }

  write(entry: AttributionEntry): void {
    this.ensureDir();
    const file = this.sessionFile(toDateString(new Date()));
    fs.appendFileSync(file, JSON.stringify(entry) + '\n', 'utf8');
  }

  readToday(): AttributionEntry[] {
    return this.readDate(toDateString(new Date()));
  }

  private readDate(dateStr: string): AttributionEntry[] {
    const file = this.sessionFile(dateStr);
    if (!fs.existsSync(file)) return [];
    const raw = fs.readFileSync(file, 'utf8');
    return parseEntries(raw);
  }

  readRange(fromDate: string, toDate: string): AttributionEntry[] {
    const from = new Date(fromDate);
    const to = new Date(toDate);
    const results: AttributionEntry[] = [];

    const cursor = new Date(from);
    while (cursor <= to) {
      results.push(...this.readDate(toDateString(cursor)));
      cursor.setUTCDate(cursor.getUTCDate() + 1);
    }

    return results;
  }
}
