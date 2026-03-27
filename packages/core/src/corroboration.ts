import { AITool, DetectionMethod } from './types.js';

// ── Signal weight defaults ────────────────────────────────────────────────────

/**
 * Default reliability weight (0–1) assigned to each DetectionMethod.
 * FILE_WATCHER's full weight of 0.70 requires metadata.sessionMatch === true;
 * without it the weight is reduced to FILE_WATCHER_NO_SESSION_WEIGHT.
 */
export const SIGNAL_WEIGHTS: Record<DetectionMethod, number> = {
  [DetectionMethod.SHELL_WRAPPER]:       0.85,
  [DetectionMethod.CO_AUTHOR_TRAILER]:   0.80,
  [DetectionMethod.FILE_WATCHER]:        0.70,
  [DetectionMethod.EXTERNAL_FILE_WRITE]: 0.50,
  [DetectionMethod.MULTI_FILE_BURST]:    0.45,
  [DetectionMethod.LARGE_INSERTION]:     0.40,
  [DetectionMethod.MANUAL]:              1.00,
};

/** Applied to FILE_WATCHER when no corroborating session record is present. */
const FILE_WATCHER_NO_SESSION_WEIGHT = 0.55;

// ── Public types ──────────────────────────────────────────────────────────────

/** One piece of evidence that an AI tool made a contribution. */
export interface DetectionSignal {
  method: DetectionMethod;
  tool: AITool;
  /**
   * Arbitrary structured metadata about the signal.
   * Recognised keys:
   *   - `sessionMatch` (boolean) — for FILE_WATCHER: whether a shell-wrapper
   *     session record was found that overlaps this file write.
   */
  metadata?: Record<string, unknown>;
}

/** A signal after its effective weight has been resolved. */
export interface ScoredSignal {
  method: DetectionMethod;
  weight: number;
  metadata: Record<string, unknown>;
}

export interface CorroborationResult {
  /** Each input signal with its resolved weight and metadata. */
  signals: ScoredSignal[];
  /**
   * Combined attribution score in [0, 1], computed via noisy-OR
   * (diminishing returns).  Boosted +0.10 when all signals agree on tool.
   */
  compositeScore: number;
  confidence: 'high' | 'medium' | 'low';
  /**
   * Human-readable explanation of how each signal contributed and any
   * agreement / conflict adjustments that were applied.
   */
  reasoning: string[];
}

// ── Internal helpers ──────────────────────────────────────────────────────────

function resolveWeight(signal: DetectionSignal): number {
  if (
    signal.method === DetectionMethod.FILE_WATCHER &&
    signal.metadata?.['sessionMatch'] !== true
  ) {
    return FILE_WATCHER_NO_SESSION_WEIGHT;
  }
  return SIGNAL_WEIGHTS[signal.method];
}

function scoreToConfidence(score: number): 'high' | 'medium' | 'low' {
  if (score >= 0.75) return 'high';
  if (score >= 0.45) return 'medium';
  return 'low';
}

function degradeConfidence(
  level: 'high' | 'medium' | 'low',
): 'high' | 'medium' | 'low' {
  if (level === 'high') return 'medium';
  return 'low'; // medium → low, low → low
}

const METHOD_DESCRIPTIONS: Record<DetectionMethod, string> = {
  [DetectionMethod.SHELL_WRAPPER]:
    'shell wrapper intercepted the tool invocation directly',
  [DetectionMethod.CO_AUTHOR_TRAILER]:
    'Co-Authored-By trailer found in git commit body',
  [DetectionMethod.FILE_WATCHER]:
    'file-system watcher observed a write during an active tool session',
  [DetectionMethod.LARGE_INSERTION]:
    'unusually large block insertion detected in a single edit event',
  [DetectionMethod.MULTI_FILE_BURST]:
    'simultaneous multi-file changes match a known agent burst pattern',
  [DetectionMethod.EXTERNAL_FILE_WRITE]:
    'file was written by a process outside the editor',
  [DetectionMethod.MANUAL]:
    'attribution set manually by the developer',
};

// ── Core algorithm ────────────────────────────────────────────────────────────

/**
 * Combine one or more detection signals into a single corroboration result.
 *
 * Scoring uses noisy-OR (also called "at-least-one" / diminishing-returns):
 *
 *   compositeScore = 1 − ∏(1 − wᵢ)
 *
 * This means each additional signal raises the score, but with decreasing
 * marginal gain — a second 0.85 signal cannot simply add another 0.85.
 *
 * Adjustments applied after the base score:
 *  - +0.10 if all signals agree on the same AITool (capped at 1.0)
 *  - confidence tier degraded one step if signals disagree on the tool
 */
export function corroborateAttribution(
  signals: DetectionSignal[],
): CorroborationResult {
  if (signals.length === 0) {
    return {
      signals: [],
      compositeScore: 0,
      confidence: 'low',
      reasoning: ['No signals provided — attribution cannot be established.'],
    };
  }

  // Resolve effective weight for each signal
  const scored: ScoredSignal[] = signals.map((s) => ({
    method:   s.method,
    weight:   resolveWeight(s),
    metadata: s.metadata ?? {},
  }));

  // Noisy-OR composite: running = 1 − ∏(1 − wᵢ)
  let compositeScore = scored.reduce(
    (carry, s) => 1 - (1 - carry) * (1 - s.weight),
    0,
  );

  // Detect tool agreement / conflict
  const tools = new Set(signals.map((s) => s.tool));
  const toolsAgree   = tools.size === 1 && signals.length > 1;
  const toolsConflict = tools.size > 1;

  if (toolsAgree) {
    compositeScore = Math.min(1.0, compositeScore + 0.1);
  }

  // Round to 3 decimal places to avoid floating-point noise in comparisons
  compositeScore = Math.round(compositeScore * 1000) / 1000;

  // Derive confidence; degrade one tier on tool conflict
  let confidence = scoreToConfidence(compositeScore);
  if (toolsConflict) {
    confidence = degradeConfidence(confidence);
  }

  // Build per-signal reasoning strings
  const reasoning: string[] = [];
  let runningScore = 0;

  for (const s of scored) {
    const prev = runningScore;
    runningScore = 1 - (1 - prev) * (1 - s.weight);
    const delta = runningScore - prev;

    const sessionNote =
      s.method === DetectionMethod.FILE_WATCHER &&
      s.metadata['sessionMatch'] !== true
        ? ' (no matching session — weight reduced from 0.70 to 0.55)'
        : '';

    reasoning.push(
      `${s.method}: ${METHOD_DESCRIPTIONS[s.method]}` +
      `${sessionNote}. ` +
      `Weight ${s.weight.toFixed(2)}, adds +${delta.toFixed(3)} to composite ` +
      `(running: ${runningScore.toFixed(3)}).`,
    );
  }

  if (toolsAgree) {
    const [tool] = [...tools];
    reasoning.push(
      `All ${signals.length} signals agree on tool ${tool} — ` +
      `composite boosted by +0.10.`,
    );
  }

  if (toolsConflict) {
    reasoning.push(
      `Conflicting tools detected (${[...tools].join(', ')}) — ` +
      `confidence tier reduced by one level.`,
    );
  }

  return { signals: scored, compositeScore, confidence, reasoning };
}
