import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { SidecarWriter } from '../sidecar.js';
import { AITool, DetectionMethod } from '../types.js';
import type { AttributionEntry } from '../types.js';

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'brela-test-'));
}

function makeEntry(overrides: Partial<AttributionEntry> = {}): AttributionEntry {
  return {
    file: 'src/foo.ts',
    tool: AITool.COPILOT,
    confidence: 'high',
    detectionMethod: DetectionMethod.LARGE_INSERTION,
    linesStart: 1,
    linesEnd: 10,
    charsInserted: 200,
    timestamp: new Date().toISOString(),
    sessionId: 'abc12345',
    accepted: true,
    ...overrides,
  };
}

describe('SidecarWriter', () => {
  let tmpDir: string;
  let writer: SidecarWriter;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    writer = new SidecarWriter(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('creates .brela/sessions/ on first write', () => {
    writer.write(makeEntry());
    expect(fs.existsSync(path.join(tmpDir, '.brela', 'sessions'))).toBe(true);
  });

  it('writes one entry per line (NDJSON)', () => {
    writer.write(makeEntry({ file: 'a.ts' }));
    writer.write(makeEntry({ file: 'b.ts' }));

    const dateStr = new Date().toISOString().slice(0, 10);
    const raw = fs.readFileSync(
      path.join(tmpDir, '.brela', 'sessions', `${dateStr}.json`),
      'utf8',
    );
    const lines = raw.trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!).file).toBe('a.ts');
    expect(JSON.parse(lines[1]!).file).toBe('b.ts');
  });

  it('readToday() returns all entries written today', () => {
    writer.write(makeEntry({ file: 'x.ts' }));
    writer.write(makeEntry({ file: 'y.ts' }));

    const entries = writer.readToday();
    expect(entries).toHaveLength(2);
    expect(entries[0]!.file).toBe('x.ts');
    expect(entries[1]!.file).toBe('y.ts');
  });

  it('readToday() returns [] when no file exists', () => {
    expect(writer.readToday()).toEqual([]);
  });

  it('readRange() returns entries across multiple date files', () => {
    // Write directly into dated files to simulate past days
    const sessionsDir = path.join(tmpDir, '.brela', 'sessions');
    fs.mkdirSync(sessionsDir, { recursive: true });

    const e1 = makeEntry({ file: 'day1.ts', timestamp: '2024-01-01T10:00:00Z' });
    const e2 = makeEntry({ file: 'day2.ts', timestamp: '2024-01-02T10:00:00Z' });
    const e3 = makeEntry({ file: 'day3.ts', timestamp: '2024-01-03T10:00:00Z' });

    fs.writeFileSync(path.join(sessionsDir, '2024-01-01.json'), JSON.stringify(e1) + '\n');
    fs.writeFileSync(path.join(sessionsDir, '2024-01-02.json'), JSON.stringify(e2) + '\n');
    fs.writeFileSync(path.join(sessionsDir, '2024-01-03.json'), JSON.stringify(e3) + '\n');

    const results = writer.readRange('2024-01-01', '2024-01-03');
    expect(results).toHaveLength(3);
    expect(results.map((e) => e.file)).toEqual(['day1.ts', 'day2.ts', 'day3.ts']);
  });

  it('readRange() skips missing date files silently', () => {
    const sessionsDir = path.join(tmpDir, '.brela', 'sessions');
    fs.mkdirSync(sessionsDir, { recursive: true });

    const e = makeEntry({ file: 'only-day.ts' });
    fs.writeFileSync(path.join(sessionsDir, '2024-06-01.json'), JSON.stringify(e) + '\n');

    // Range includes 2024-06-02 which has no file
    const results = writer.readRange('2024-06-01', '2024-06-03');
    expect(results).toHaveLength(1);
    expect(results[0]!.file).toBe('only-day.ts');
  });

  it('write() is idempotent on repeated dir creation', () => {
    // Calling write multiple times should not throw even if dir already exists
    writer.write(makeEntry());
    writer.write(makeEntry());
    expect(writer.readToday()).toHaveLength(2);
  });

  it('serialises and deserialises all fields correctly', () => {
    const entry = makeEntry({
      tool: AITool.CLAUDE_CODE,
      confidence: 'low',
      detectionMethod: DetectionMethod.CO_AUTHOR_TRAILER,
      linesStart: 5,
      linesEnd: 42,
      charsInserted: 999,
      sessionId: 'xyz99999',
      accepted: false,
    });
    writer.write(entry);

    const [read] = writer.readToday();
    expect(read).toEqual(entry);
  });
});
