import { describe, it, expect } from 'vitest';
import { assessHumanAuthorship } from '../negative-attribution.js';
import type { HumanAttributionEvidence } from '../negative-attribution.js';

// ── Fixtures ──────────────────────────────────────────────────────────────────

const FILES = ['src/auth.ts', 'src/utils.ts'];

const TIME_RANGE = { start: 1_700_000_000_000, end: 1_700_000_060_000 }; // 60-second window

/** A session that does NOT overlap the time range. */
const PAST_SESSION = {
  aiTool: 'COPILOT',
  start:  1_699_999_000_000,
  end:    1_699_999_900_000,
};

/** A session that overlaps the time range. */
const OVERLAPPING_SESSION = {
  aiTool: 'CLAUDE_CODE_AGENT',
  start:  1_700_000_030_000,
  end:    1_700_000_090_000,
};

const ALL_MONITORS_ON = { shellWrapper: true, fileWatcher: true, editorTelemetry: true };
const NO_PROCESSES: Array<{ filePath: string; aiTool: string | null }> = [];
const AI_PROCESS = [{ filePath: 'src/auth.ts', aiTool: 'CODEIUM' }];

function baseParams() {
  return {
    filePaths:           FILES,
    timeRange:           TIME_RANGE,
    activeSessions:      [] as typeof PAST_SESSION[],
    monitoringStatus:    ALL_MONITORS_ON,
    processCorrelations: NO_PROCESSES,
  };
}

// ── human_authored ────────────────────────────────────────────────────────────

describe('human_authored verdict', () => {
  it('returns human_authored when all monitors are clean and no AI activity', () => {
    const result = assessHumanAuthorship(baseParams());
    expect(result.verdict).toBe('human_authored');
  });

  it('sets activeAISessions false when no sessions exist', () => {
    const result = assessHumanAuthorship(baseParams());
    expect(result.activeAISessions).toBe(false);
  });

  it('sets processTreeClean true when no process correlations contain an AI tool', () => {
    const result = assessHumanAuthorship({
      ...baseParams(),
      processCorrelations: [{ filePath: 'src/auth.ts', aiTool: null }],
    });
    expect(result.processTreeClean).toBe(true);
    expect(result.verdict).toBe('human_authored');
  });

  it('sets all monitor booleans true from monitoringStatus', () => {
    const result = assessHumanAuthorship(baseParams());
    expect(result.shellWrapperRunning).toBe(true);
    expect(result.fileWatcherRunning).toBe(true);
    expect(result.editorTelemetryClean).toBe(true);
  });

  it('has high confidence (> 0.9) when all signals are clean', () => {
    const result = assessHumanAuthorship(baseParams());
    expect(result.confidence).toBeGreaterThan(0.9);
  });

  it('non-overlapping past session does not affect verdict', () => {
    const result = assessHumanAuthorship({
      ...baseParams(),
      activeSessions: [PAST_SESSION],
    });
    expect(result.activeAISessions).toBe(false);
    expect(result.verdict).toBe('human_authored');
  });

  it('includes reasoning mentioning all monitors and no AI activity', () => {
    const result = assessHumanAuthorship(baseParams());
    expect(result.reasoning.length).toBeGreaterThan(0);
    expect(result.reasoning.some(r => r.toLowerCase().includes('monitor'))).toBe(true);
  });

  it('fileChanges contains one entry per filePath', () => {
    const result = assessHumanAuthorship(baseParams());
    expect(result.fileChanges).toHaveLength(FILES.length);
    expect(result.fileChanges.map(c => c.filePath)).toEqual(FILES);
  });
});

// ── insufficient_monitoring ───────────────────────────────────────────────────

describe('insufficient_monitoring verdict', () => {
  it('returns insufficient_monitoring when shellWrapper is off', () => {
    const result = assessHumanAuthorship({
      ...baseParams(),
      monitoringStatus: { shellWrapper: false, fileWatcher: true, editorTelemetry: true },
    });
    expect(result.verdict).toBe('insufficient_monitoring');
    expect(result.shellWrapperRunning).toBe(false);
  });

  it('returns insufficient_monitoring when fileWatcher is off', () => {
    const result = assessHumanAuthorship({
      ...baseParams(),
      monitoringStatus: { shellWrapper: true, fileWatcher: false, editorTelemetry: true },
    });
    expect(result.verdict).toBe('insufficient_monitoring');
    expect(result.fileWatcherRunning).toBe(false);
  });

  it('returns insufficient_monitoring when editorTelemetry is off', () => {
    const result = assessHumanAuthorship({
      ...baseParams(),
      monitoringStatus: { shellWrapper: true, fileWatcher: true, editorTelemetry: false },
    });
    expect(result.verdict).toBe('insufficient_monitoring');
    expect(result.editorTelemetryClean).toBe(false);
  });

  it('returns insufficient_monitoring when all monitors are off', () => {
    const result = assessHumanAuthorship({
      ...baseParams(),
      monitoringStatus: { shellWrapper: false, fileWatcher: false, editorTelemetry: false },
    });
    expect(result.verdict).toBe('insufficient_monitoring');
  });

  it('caps confidence at 0.30 for insufficient_monitoring', () => {
    const result = assessHumanAuthorship({
      ...baseParams(),
      monitoringStatus: { shellWrapper: false, fileWatcher: false, editorTelemetry: false },
    });
    expect(result.confidence).toBeLessThanOrEqual(0.30);
  });

  it('mentions the missing component in reasoning', () => {
    const result = assessHumanAuthorship({
      ...baseParams(),
      monitoringStatus: { shellWrapper: false, fileWatcher: true, editorTelemetry: true },
    });
    expect(result.reasoning.some(r => r.toLowerCase().includes('shell wrapper'))).toBe(true);
  });

  it('insufficient_monitoring takes priority over AI session overlap', () => {
    // Even with an overlapping session, missing monitor dominates
    const result = assessHumanAuthorship({
      ...baseParams(),
      monitoringStatus: { shellWrapper: false, fileWatcher: true, editorTelemetry: true },
      activeSessions:   [OVERLAPPING_SESSION],
    });
    expect(result.verdict).toBe('insufficient_monitoring');
  });

  it('partial monitoring gives confidence between 0 and 0.30', () => {
    // Only one monitor active
    const result = assessHumanAuthorship({
      ...baseParams(),
      monitoringStatus: { shellWrapper: true, fileWatcher: false, editorTelemetry: false },
    });
    expect(result.confidence).toBeGreaterThan(0);
    expect(result.confidence).toBeLessThanOrEqual(0.30);
  });
});

// ── uncertain — AI session overlap ───────────────────────────────────────────

describe('uncertain verdict — AI session overlap', () => {
  it('returns uncertain when a session overlaps the time range', () => {
    const result = assessHumanAuthorship({
      ...baseParams(),
      activeSessions: [OVERLAPPING_SESSION],
    });
    expect(result.verdict).toBe('uncertain');
    expect(result.activeAISessions).toBe(true);
  });

  it('includes the overlapping session tool name in reasoning', () => {
    const result = assessHumanAuthorship({
      ...baseParams(),
      activeSessions: [OVERLAPPING_SESSION],
    });
    expect(result.reasoning.some(r => r.includes('CLAUDE_CODE_AGENT'))).toBe(true);
  });

  it('caps confidence at 0.40 for uncertain', () => {
    const result = assessHumanAuthorship({
      ...baseParams(),
      activeSessions: [OVERLAPPING_SESSION],
    });
    expect(result.confidence).toBeLessThanOrEqual(0.40);
  });

  it('detects session that starts before and ends within the window', () => {
    const session = { aiTool: 'CURSOR', start: TIME_RANGE.start - 5_000, end: TIME_RANGE.start + 5_000 };
    const result = assessHumanAuthorship({ ...baseParams(), activeSessions: [session] });
    expect(result.verdict).toBe('uncertain');
  });

  it('detects session that starts within and ends after the window', () => {
    const session = { aiTool: 'CURSOR', start: TIME_RANGE.end - 5_000, end: TIME_RANGE.end + 5_000 };
    const result = assessHumanAuthorship({ ...baseParams(), activeSessions: [session] });
    expect(result.verdict).toBe('uncertain');
  });

  it('detects session that fully contains the time window', () => {
    const session = { aiTool: 'AIDER', start: TIME_RANGE.start - 1_000, end: TIME_RANGE.end + 1_000 };
    const result = assessHumanAuthorship({ ...baseParams(), activeSessions: [session] });
    expect(result.verdict).toBe('uncertain');
  });

  it('does not flag a session that ends before the window starts', () => {
    const session = { aiTool: 'COPILOT', start: TIME_RANGE.start - 10_000, end: TIME_RANGE.start - 1 };
    const result = assessHumanAuthorship({ ...baseParams(), activeSessions: [session] });
    expect(result.verdict).toBe('human_authored');
  });

  it('does not flag a session that starts after the window ends', () => {
    const session = { aiTool: 'COPILOT', start: TIME_RANGE.end + 1, end: TIME_RANGE.end + 10_000 };
    const result = assessHumanAuthorship({ ...baseParams(), activeSessions: [session] });
    expect(result.verdict).toBe('human_authored');
  });

  it('mentions all overlapping sessions in reasoning', () => {
    const sessions = [
      { aiTool: 'COPILOT',          start: TIME_RANGE.start,         end: TIME_RANGE.end },
      { aiTool: 'CLAUDE_CODE_AGENT', start: TIME_RANGE.start + 1_000, end: TIME_RANGE.end },
    ];
    const result = assessHumanAuthorship({ ...baseParams(), activeSessions: sessions });
    expect(result.reasoning.some(r => r.includes('COPILOT'))).toBe(true);
    expect(result.reasoning.some(r => r.includes('CLAUDE_CODE_AGENT'))).toBe(true);
  });
});

// ── uncertain — AI process correlation ───────────────────────────────────────

describe('uncertain verdict — process correlation found AI tool', () => {
  it('returns uncertain when a process correlation identifies an AI tool', () => {
    const result = assessHumanAuthorship({
      ...baseParams(),
      processCorrelations: AI_PROCESS,
    });
    expect(result.verdict).toBe('uncertain');
    expect(result.processTreeClean).toBe(false);
  });

  it('includes the AI tool name in reasoning', () => {
    const result = assessHumanAuthorship({
      ...baseParams(),
      processCorrelations: [{ filePath: 'src/auth.ts', aiTool: 'CODEIUM' }],
    });
    expect(result.reasoning.some(r => r.includes('CODEIUM'))).toBe(true);
  });

  it('includes the file path in reasoning', () => {
    const result = assessHumanAuthorship({
      ...baseParams(),
      processCorrelations: [{ filePath: 'src/auth.ts', aiTool: 'CODEIUM' }],
    });
    expect(result.reasoning.some(r => r.includes('src/auth.ts'))).toBe(true);
  });

  it('multiple AI process hits all appear in reasoning', () => {
    const correlations = [
      { filePath: 'src/auth.ts',  aiTool: 'CODEIUM' },
      { filePath: 'src/utils.ts', aiTool: 'COPILOT' },
    ];
    const result = assessHumanAuthorship({ ...baseParams(), processCorrelations: correlations });
    expect(result.reasoning.some(r => r.includes('CODEIUM'))).toBe(true);
    expect(result.reasoning.some(r => r.includes('COPILOT'))).toBe(true);
  });

  it('caps confidence at 0.40 for uncertain via process correlation', () => {
    const result = assessHumanAuthorship({
      ...baseParams(),
      processCorrelations: AI_PROCESS,
    });
    expect(result.confidence).toBeLessThanOrEqual(0.40);
  });

  it('null aiTool in processCorrelations does not trigger uncertain', () => {
    const result = assessHumanAuthorship({
      ...baseParams(),
      processCorrelations: [{ filePath: 'src/auth.ts', aiTool: null }],
    });
    expect(result.verdict).toBe('human_authored');
    expect(result.processTreeClean).toBe(true);
  });
});

// ── edge cases ────────────────────────────────────────────────────────────────

describe('edge cases', () => {
  it('empty filePaths still returns a verdict', () => {
    const result = assessHumanAuthorship({ ...baseParams(), filePaths: [] });
    expect(result.verdict).toBe('human_authored');
    expect(result.fileChanges).toHaveLength(0);
  });

  it('confidence is always in [0, 1]', () => {
    const cases = [
      baseParams(),
      { ...baseParams(), monitoringStatus: { shellWrapper: false, fileWatcher: false, editorTelemetry: false } },
      { ...baseParams(), activeSessions: [OVERLAPPING_SESSION] },
      { ...baseParams(), processCorrelations: AI_PROCESS },
    ];
    for (const p of cases) {
      const { confidence } = assessHumanAuthorship(p);
      expect(confidence).toBeGreaterThanOrEqual(0);
      expect(confidence).toBeLessThanOrEqual(1);
    }
  });

  it('reasoning is never empty', () => {
    const cases = [
      baseParams(),
      { ...baseParams(), monitoringStatus: { shellWrapper: false, fileWatcher: true, editorTelemetry: true } },
      { ...baseParams(), activeSessions: [OVERLAPPING_SESSION] },
      { ...baseParams(), processCorrelations: AI_PROCESS },
    ];
    for (const p of cases) {
      expect(assessHumanAuthorship(p).reasoning.length).toBeGreaterThan(0);
    }
  });
});
