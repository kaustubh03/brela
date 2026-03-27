import { describe, it, expect } from 'vitest';
import {
  generateAttributionReport,
  formatReportAsMarkdown,
  formatReportAsJSON,
} from '../attribution-report.js';
import { AITool } from '../types.js';

// ── Fixtures ──────────────────────────────────────────────────────────────────

const BASE_TS = 1_700_000_000_000;

const FULL_SIGNALS = [
  { method: 'shell_wrapper',    detected: true,  metadata: { detail: 'claude wrapper intercepted invocation' } },
  { method: 'process_tree',     detected: true,  metadata: { detail: 'claude process detected writing file' } },
  { method: 'file_watcher',     detected: true,  metadata: { detail: 'rapid multi-file burst detected' } },
  { method: 'editor_telemetry', detected: false, metadata: { detail: 'no completion events observed' } },
  { method: 'diff_analysis',    detected: true,  metadata: { detail: 'aiLikelihood=0.82' } },
];

const FULL_PARAMS = {
  filePath:  'src/auth/token.ts',
  lineRange: { start: 45, end: 89 },
  timestamp: BASE_TS,
  detectionSignals: FULL_SIGNALS,
  aiTool:    'CLAUDE_CODE',
  classificationResult: { classification: 'ai_generated', aiRatio: 0.95 },
  corroborationResult:  { compositeScore: 0.87, signals: FULL_SIGNALS.map(s => ({ method: s.method, weight: 0.5 })) },
  integrityHash: 'abc123def456',
  crossValidation: { status: 'confirmed', commitHash: 'deadbeef12345678', timeDeltaMs: 42_000 },
};

// ── generateAttributionReport ─────────────────────────────────────────────────

describe('generateAttributionReport — full report', () => {
  it('returns an object with a valid UUID id', () => {
    const r = generateAttributionReport(FULL_PARAMS);
    expect(r.id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('echoes filePath and lineRange', () => {
    const r = generateAttributionReport(FULL_PARAMS);
    expect(r.filePath).toBe('src/auth/token.ts');
    expect(r.lineRange).toEqual({ start: 45, end: 89 });
  });

  it('maps aiTool string to AITool enum', () => {
    const r = generateAttributionReport(FULL_PARAMS);
    expect(r.aiTool).toBe(AITool.CLAUDE_CODE);
  });

  it('uses classification from classificationResult', () => {
    const r = generateAttributionReport(FULL_PARAMS);
    expect(r.classification).toBe('ai_generated');
  });

  it('uses compositeScore from corroborationResult for confidence', () => {
    const r = generateAttributionReport(FULL_PARAMS);
    expect(r.confidence.score).toBe(0.87);
  });

  it('assigns HIGH tier when score >= 0.75', () => {
    const r = generateAttributionReport(FULL_PARAMS);
    expect(r.confidence.tier).toBe('high');
  });

  it('maps MEDIUM tier for score 0.50–0.74', () => {
    const r = generateAttributionReport({
      ...FULL_PARAMS,
      corroborationResult: { compositeScore: 0.60, signals: [] },
    });
    expect(r.confidence.tier).toBe('medium');
  });

  it('maps LOW tier for score < 0.50', () => {
    const r = generateAttributionReport({
      ...FULL_PARAMS,
      corroborationResult: { compositeScore: 0.35, signals: [] },
    });
    expect(r.confidence.tier).toBe('low');
  });

  it('populates signals array with one entry per detectionSignal', () => {
    const r = generateAttributionReport(FULL_PARAMS);
    expect(r.signals).toHaveLength(FULL_SIGNALS.length);
  });

  it('maps detected:true signals correctly', () => {
    const r = generateAttributionReport(FULL_PARAMS);
    const sw = r.signals.find(s => s.source === 'shell_wrapper')!;
    expect(sw.detected).toBe(true);
    expect(sw.weight).toBeGreaterThan(0);
  });

  it('maps detected:false signals correctly', () => {
    const r = generateAttributionReport(FULL_PARAMS);
    const et = r.signals.find(s => s.source === 'editor_telemetry')!;
    expect(et.detected).toBe(false);
  });

  it('detail from metadata is used', () => {
    const r = generateAttributionReport(FULL_PARAMS);
    const sw = r.signals.find(s => s.source === 'shell_wrapper')!;
    expect(sw.detail).toBe('claude wrapper intercepted invocation');
  });

  it('corroboration signalsAgreed counts detected signals', () => {
    const r = generateAttributionReport(FULL_PARAMS);
    const expectedAgreed = FULL_SIGNALS.filter(s => s.detected).length;
    expect(r.corroboration.signalsAgreed).toBe(expectedAgreed);
  });

  it('corroboration signalsConflicted counts non-detected signals', () => {
    const r = generateAttributionReport(FULL_PARAMS);
    const expectedConflicted = FULL_SIGNALS.filter(s => !s.detected).length;
    expect(r.corroboration.signalsConflicted).toBe(expectedConflicted);
  });

  it('integrityHash is echoed', () => {
    const r = generateAttributionReport(FULL_PARAMS);
    expect(r.integrityHash).toBe('abc123def456');
  });

  it('gitCrossRef is populated', () => {
    const r = generateAttributionReport(FULL_PARAMS);
    expect(r.gitCrossRef).not.toBeNull();
    expect(r.gitCrossRef!.status).toBe('confirmed');
    expect(r.gitCrossRef!.commitHash).toBe('deadbeef12345678');
    expect(r.gitCrossRef!.timeDelta).toBe(42_000);
  });

  it('humanReadableSummary mentions file, tool, tier, and classification', () => {
    const r = generateAttributionReport(FULL_PARAMS);
    expect(r.humanReadableSummary).toContain('src/auth/token.ts');
    expect(r.humanReadableSummary).toContain('CLAUDE_CODE');
    expect(r.humanReadableSummary).toContain('HIGH');
    expect(r.humanReadableSummary).toContain('ai_generated');
  });

  it('humanReadableSummary mentions the git cross-validation status', () => {
    const r = generateAttributionReport(FULL_PARAMS);
    expect(r.humanReadableSummary).toContain('confirmed');
  });
});

// ── Partial report ────────────────────────────────────────────────────────────

describe('generateAttributionReport — partial report (no optional fields)', () => {
  const PARTIAL_PARAMS = {
    filePath:         'src/utils.ts',
    timestamp:        BASE_TS,
    detectionSignals: [{ method: 'file_watcher', detected: true }],
  };

  it('lineRange is null when not provided', () => {
    expect(generateAttributionReport(PARTIAL_PARAMS).lineRange).toBeNull();
  });

  it('aiTool is null when not provided', () => {
    expect(generateAttributionReport(PARTIAL_PARAMS).aiTool).toBeNull();
  });

  it('classification defaults to "unknown"', () => {
    expect(generateAttributionReport(PARTIAL_PARAMS).classification).toBe('unknown');
  });

  it('integrityHash is null when not provided', () => {
    expect(generateAttributionReport(PARTIAL_PARAMS).integrityHash).toBeNull();
  });

  it('gitCrossRef is null when not provided', () => {
    expect(generateAttributionReport(PARTIAL_PARAMS).gitCrossRef).toBeNull();
  });

  it('computes compositeScore via noisy-OR when corroborationResult absent', () => {
    const r = generateAttributionReport(PARTIAL_PARAMS);
    // file_watcher detected → noisy-OR of its weight > 0
    expect(r.confidence.score).toBeGreaterThan(0);
    expect(r.confidence.score).toBeLessThanOrEqual(1);
  });

  it('humanReadableSummary says no git validation was performed', () => {
    const r = generateAttributionReport(PARTIAL_PARAMS);
    expect(r.humanReadableSummary).toMatch(/no git blame cross-validation/i);
  });

  it('empty detectionSignals results in compositeScore of 0', () => {
    const r = generateAttributionReport({ ...PARTIAL_PARAMS, detectionSignals: [] });
    expect(r.confidence.score).toBe(0);
    expect(r.confidence.tier).toBe('low');
  });

  it('unknown signal source gets a default weight of 0.30', () => {
    const r = generateAttributionReport({
      ...PARTIAL_PARAMS,
      detectionSignals: [{ method: 'custom_signal', detected: true }],
    });
    const sig = r.signals.find(s => s.source === 'custom_signal')!;
    expect(sig.weight).toBe(0.30);
  });
});

// ── formatReportAsMarkdown ────────────────────────────────────────────────────

describe('formatReportAsMarkdown', () => {
  let md: string;

  beforeAll(() => {
    md = formatReportAsMarkdown(generateAttributionReport(FULL_PARAMS));
  });

  it('starts with an H2 heading', () => {
    expect(md.startsWith('## Attribution Report')).toBe(true);
  });

  it('contains the file path', () => {
    expect(md).toContain('src/auth/token.ts');
  });

  it('contains the AI tool', () => {
    expect(md).toContain('CLAUDE_CODE');
  });

  it('contains the confidence section', () => {
    expect(md).toContain('### Confidence');
  });

  it('contains the detection signals table with header row', () => {
    expect(md).toContain('### Detection Signals');
    expect(md).toContain('| Source | Detected | Weight | Detail |');
  });

  it('renders each signal as a table row', () => {
    for (const s of FULL_SIGNALS) {
      expect(md).toContain(s.method);
    }
  });

  it('contains the corroboration section', () => {
    expect(md).toContain('### Corroboration');
    expect(md).toContain('Signals agreed');
  });

  it('contains the integrity section', () => {
    expect(md).toContain('### Integrity');
    expect(md).toContain('abc123def456');
  });

  it('contains the git cross-validation section', () => {
    expect(md).toContain('### Git Cross-Validation');
    expect(md).toContain('confirmed');
  });

  it('contains the summary section', () => {
    expect(md).toContain('### Summary');
    expect(md).toContain('HIGH');
  });

  it('renders "not recorded" when integrityHash is null', () => {
    const r = generateAttributionReport({ ...FULL_PARAMS, integrityHash: undefined });
    const partialMd = formatReportAsMarkdown(r);
    expect(partialMd).toContain('not recorded');
  });

  it('renders "Not performed" when gitCrossRef is null', () => {
    const r = generateAttributionReport({ ...FULL_PARAMS, crossValidation: undefined });
    const partialMd = formatReportAsMarkdown(r);
    expect(partialMd).toContain('Not performed');
  });
});

// ── formatReportAsJSON ────────────────────────────────────────────────────────

describe('formatReportAsJSON', () => {
  it('returns valid JSON', () => {
    const r = generateAttributionReport(FULL_PARAMS);
    expect(() => JSON.parse(formatReportAsJSON(r))).not.toThrow();
  });

  it('output is deterministic — same report produces same JSON', () => {
    const r = generateAttributionReport(FULL_PARAMS);
    expect(formatReportAsJSON(r)).toBe(formatReportAsJSON(r));
  });

  it('keys are sorted at the top level', () => {
    const r = generateAttributionReport(FULL_PARAMS);
    const parsed = JSON.parse(formatReportAsJSON(r)) as Record<string, unknown>;
    const keys = Object.keys(parsed);
    expect(keys).toEqual([...keys].sort());
  });

  it('nested object keys are also sorted', () => {
    const r = generateAttributionReport(FULL_PARAMS);
    const parsed = JSON.parse(formatReportAsJSON(r)) as { confidence: Record<string, unknown> };
    const confKeys = Object.keys(parsed.confidence);
    expect(confKeys).toEqual([...confKeys].sort());
  });

  it('contains all top-level fields', () => {
    const r = generateAttributionReport(FULL_PARAMS);
    const parsed = JSON.parse(formatReportAsJSON(r)) as Record<string, unknown>;
    const required = ['aiTool', 'classification', 'confidence', 'corroboration',
      'filePath', 'gitCrossRef', 'humanReadableSummary', 'id',
      'integrityHash', 'lineRange', 'signals', 'timestamp'];
    for (const key of required) {
      expect(parsed).toHaveProperty(key);
    }
  });

  it('two reports with different IDs produce different JSON', () => {
    const r1 = generateAttributionReport(FULL_PARAMS);
    const r2 = generateAttributionReport(FULL_PARAMS);
    // IDs differ; everything else same
    expect(r1.id).not.toBe(r2.id);
    expect(formatReportAsJSON(r1)).not.toBe(formatReportAsJSON(r2));
  });
});

// ── import helper ─────────────────────────────────────────────────────────────
// vitest doesn't expose beforeAll in the outer scope without import;
// re-declare it here to satisfy TypeScript.
import { beforeAll } from 'vitest';
