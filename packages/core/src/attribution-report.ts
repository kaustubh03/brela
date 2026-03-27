import { randomUUID } from 'node:crypto';
import { AITool } from './types.js';
import { SIGNAL_WEIGHTS } from './corroboration.js';
import { DetectionMethod } from './types.js';

// ── Public interface ───────────────────────────────────────────────────────────

export interface AttributionReport {
  id:          string;
  filePath:    string;
  lineRange:   { start: number; end: number } | null;
  timestamp:   number;
  aiTool:      AITool | null;
  /** Classification tier label, e.g. 'ai_generated' or 'unknown'. */
  classification: string;
  confidence:  { score: number; tier: 'high' | 'medium' | 'low' };
  signals:     Array<{
    source:   string;
    detected: boolean;
    weight:   number;
    detail:   string;
  }>;
  corroboration: {
    signalsAgreed:    number;
    signalsConflicted: number;
    compositeScore:   number;
  };
  integrityHash: string | null;
  gitCrossRef: {
    status:     string;
    commitHash: string | null;
    timeDelta:  number | null;
  } | null;
  humanReadableSummary: string;
}

// ── Source → DetectionMethod mapping ─────────────────────────────────────────

const SOURCE_TO_METHOD: Record<string, DetectionMethod> = {
  shell_wrapper:    DetectionMethod.SHELL_WRAPPER,
  co_author:        DetectionMethod.CO_AUTHOR_TRAILER,
  file_watcher:     DetectionMethod.FILE_WATCHER,
  external_write:   DetectionMethod.EXTERNAL_FILE_WRITE,
  multi_file_burst: DetectionMethod.MULTI_FILE_BURST,
  large_insertion:  DetectionMethod.LARGE_INSERTION,
  manual:           DetectionMethod.MANUAL,
  // aliases used in reports
  process_tree:     DetectionMethod.EXTERNAL_FILE_WRITE,
  diff_analysis:    DetectionMethod.LARGE_INSERTION,
  editor_telemetry: DetectionMethod.MULTI_FILE_BURST,
};

// ── Helpers ────────────────────────────────────────────────────────────────────

function weightForSource(source: string): number {
  const method = SOURCE_TO_METHOD[source];
  if (method === undefined) return 0.30; // sensible default for unknown sources
  return SIGNAL_WEIGHTS[method];
}

function confidenceTier(score: number): 'high' | 'medium' | 'low' {
  if (score >= 0.75) return 'high';
  if (score >= 0.50) return 'medium';
  return 'low';
}

/**
 * Noisy-OR composite from a list of (weight, detected) pairs.
 * Detected signals contribute their weight; non-detected signals contribute 0.
 */
function noisyOr(weights: number[]): number {
  if (weights.length === 0) return 0;
  const product = weights.reduce((acc, w) => acc * (1 - w), 1);
  return Math.round(Math.min(1, Math.max(0, 1 - product)) * 100) / 100;
}

function aiToolFromString(s: string | undefined): AITool | null {
  if (!s) return null;
  const match = Object.values(AITool).find(v => v === s.toUpperCase());
  return (match as AITool) ?? null;
}

function formatDate(ts: number): string {
  return new Date(ts).toISOString();
}

// ── generateAttributionReport ─────────────────────────────────────────────────

export function generateAttributionReport(params: {
  filePath:             string;
  lineRange?:           { start: number; end: number };
  timestamp:            number;
  detectionSignals:     Array<{ method: string; detected: boolean; metadata?: Record<string, unknown> }>;
  aiTool?:              string;
  classificationResult?: { classification: string; aiRatio: number };
  corroborationResult?:  { compositeScore: number; signals: Array<{ method: string; weight: number }> };
  integrityHash?:        string;
  crossValidation?:      { status: string; commitHash?: string; timeDeltaMs?: number };
}): AttributionReport {
  const {
    filePath,
    lineRange        = null,
    timestamp,
    detectionSignals,
    aiTool,
    classificationResult,
    corroborationResult,
    integrityHash    = null,
    crossValidation  = null,
  } = params;

  // ── Signals ───────────────────────────────────────────────────────────────
  const signals = detectionSignals.map(s => {
    const weight = weightForSource(s.method);
    const meta   = s.metadata ?? {};
    const detail = (meta['detail'] as string | undefined) ?? (s.detected ? `${s.method} detected AI activity` : `${s.method} found no AI activity`);
    return { source: s.method, detected: s.detected, weight, detail };
  });

  // ── Corroboration ─────────────────────────────────────────────────────────
  const signalsAgreed    = signals.filter(s => s.detected).length;
  const signalsConflicted = signals.filter(s => !s.detected).length;

  let compositeScore: number;
  if (corroborationResult) {
    compositeScore = corroborationResult.compositeScore;
  } else {
    compositeScore = noisyOr(signals.filter(s => s.detected).map(s => s.weight));
  }

  // ── Confidence ────────────────────────────────────────────────────────────
  const confidenceScore = compositeScore;
  const tier = confidenceTier(confidenceScore);

  // ── Cross-ref ─────────────────────────────────────────────────────────────
  const gitCrossRef = crossValidation
    ? {
        status:     crossValidation.status,
        commitHash: crossValidation.commitHash ?? null,
        timeDelta:  crossValidation.timeDeltaMs ?? null,
      }
    : null;

  // ── Human readable summary ────────────────────────────────────────────────
  const toolLabel      = aiTool ?? 'an unknown AI tool';
  const locationLabel  = lineRange
    ? `${filePath} (lines ${lineRange.start}–${lineRange.end})`
    : filePath;
  const classLabel     = classificationResult?.classification ?? 'unknown';
  const aiRatioPct     = classificationResult
    ? ` (AI ratio: ${(classificationResult.aiRatio * 100).toFixed(0)}%)`
    : '';

  const detectedSources = signals.filter(s => s.detected).map(s => s.source.replace(/_/g, ' '));
  const signalSentence = detectedSources.length > 0
    ? `${detectedSources.length} detection signal${detectedSources.length > 1 ? 's' : ''} fired: ${detectedSources.join(', ')}.`
    : 'No detection signals fired.';

  const crossRefSentence = gitCrossRef
    ? `Git blame cross-validation returned status '${gitCrossRef.status}'.`
    : 'No git blame cross-validation was performed.';

  const humanReadableSummary =
    `This change in ${locationLabel} was attributed to ${toolLabel} with ${tier.toUpperCase()} ` +
    `confidence (score: ${confidenceScore.toFixed(2)}); classification: ${classLabel}${aiRatioPct}. ` +
    `${signalSentence} ` +
    `${crossRefSentence}`;

  return {
    id:             randomUUID(),
    filePath,
    lineRange,
    timestamp,
    aiTool:         aiToolFromString(aiTool),
    classification: classLabel,
    confidence:     { score: confidenceScore, tier },
    signals,
    corroboration:  { signalsAgreed, signalsConflicted, compositeScore },
    integrityHash:  integrityHash ?? null,
    gitCrossRef,
    humanReadableSummary,
  };
}

// ── formatReportAsMarkdown ────────────────────────────────────────────────────

export function formatReportAsMarkdown(report: AttributionReport): string {
  const lines: string[] = [];

  lines.push(`## Attribution Report`);
  lines.push(``);
  lines.push(`**ID:** \`${report.id}\``);
  lines.push(`**File:** \`${report.filePath}\``);
  if (report.lineRange) {
    lines.push(`**Lines:** ${report.lineRange.start}–${report.lineRange.end}`);
  }
  lines.push(`**Timestamp:** ${formatDate(report.timestamp)}`);
  lines.push(`**AI Tool:** ${report.aiTool ?? 'unknown'}`);
  lines.push(`**Classification:** ${report.classification}`);
  lines.push(``);

  // Confidence
  const tierBadge = report.confidence.tier === 'high' ? '🟢' : report.confidence.tier === 'medium' ? '🟡' : '🔴';
  lines.push(`### Confidence`);
  lines.push(``);
  lines.push(`${tierBadge} **${report.confidence.tier.toUpperCase()}** — score: \`${report.confidence.score.toFixed(2)}\``);
  lines.push(``);

  // Signals
  lines.push(`### Detection Signals`);
  lines.push(``);
  lines.push(`| Source | Detected | Weight | Detail |`);
  lines.push(`|--------|----------|--------|--------|`);
  for (const s of report.signals) {
    const detected = s.detected ? '✅ Yes' : '❌ No';
    lines.push(`| ${s.source} | ${detected} | ${s.weight.toFixed(2)} | ${s.detail} |`);
  }
  lines.push(``);

  // Corroboration
  lines.push(`### Corroboration`);
  lines.push(``);
  lines.push(`- **Signals agreed:** ${report.corroboration.signalsAgreed}`);
  lines.push(`- **Signals conflicted:** ${report.corroboration.signalsConflicted}`);
  lines.push(`- **Composite score:** ${report.corroboration.compositeScore.toFixed(2)}`);
  lines.push(``);

  // Integrity
  lines.push(`### Integrity`);
  lines.push(``);
  lines.push(`**Chain hash:** ${report.integrityHash ? `\`${report.integrityHash}\`` : '_not recorded_'}`);
  lines.push(``);

  // Git cross-reference
  lines.push(`### Git Cross-Validation`);
  lines.push(``);
  if (report.gitCrossRef) {
    lines.push(`- **Status:** ${report.gitCrossRef.status}`);
    lines.push(`- **Commit:** ${report.gitCrossRef.commitHash ?? '_unknown_'}`);
    const delta = report.gitCrossRef.timeDelta;
    lines.push(`- **Time delta:** ${delta !== null ? `${(delta / 1_000).toFixed(1)}s` : '_unknown_'}`);
  } else {
    lines.push(`_Not performed_`);
  }
  lines.push(``);

  // Summary
  lines.push(`### Summary`);
  lines.push(``);
  lines.push(report.humanReadableSummary);
  lines.push(``);

  return lines.join('\n');
}

// ── formatReportAsJSON ────────────────────────────────────────────────────────

/** Deterministic JSON output with recursively sorted keys. */
export function formatReportAsJSON(report: AttributionReport): string {
  return JSON.stringify(sortKeys(report as unknown as JsonValue), null, 2);
}

// ── JSON key-sorting utility ──────────────────────────────────────────────────

type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [k: string]: JsonValue };

function sortKeys(value: JsonValue): JsonValue {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(sortKeys);
  const sorted: { [k: string]: JsonValue } = {};
  for (const key of Object.keys(value).sort()) {
    sorted[key] = sortKeys((value as { [k: string]: JsonValue })[key]!);
  }
  return sorted;
}
