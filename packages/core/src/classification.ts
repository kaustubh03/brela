// ── Enum ───────────────────────────────────────────────────────────────────────

export enum AttributionClass {
  HUMAN_ONLY                    = 'human_only',
  AI_ASSISTED                   = 'ai_assisted',
  AI_GENERATED_HUMAN_MODIFIED   = 'ai_generated_human_modified',
  AI_GENERATED                  = 'ai_generated',
}

// ── Public interfaces ──────────────────────────────────────────────────────────

export interface ClassificationResult {
  classification:      AttributionClass;
  /** 0–1 estimated fraction of the final code that is AI-originated. */
  aiRatio:             number;
  /** The initial AI-generated diff, if an AI session was detected. */
  originalAIDiff:      string | null;
  /** Concatenated subsequent human edits to the AI output, if any. */
  humanModifications:  string | null;
  reasoning:           string[];
}

// ── diffSurvivalRate ───────────────────────────────────────────────────────────

/**
 * Return the fraction (0–1) of added lines from `original` that still appear
 * as added lines in `modified`.
 *
 * Uses set-membership so duplicate lines are counted once.  Returns 0 when
 * `original` has no added lines (nothing to survive).
 */
export function diffSurvivalRate(original: string, modified: string): number {
  const originalLines = extractAddedLines(original);
  if (originalLines.size === 0) return 0;

  const modifiedLines = extractAddedLines(modified);

  let survived = 0;
  for (const line of originalLines) {
    if (modifiedLines.has(line)) survived++;
  }

  return round2(survived / originalLines.size);
}

// ── classifyAttribution ────────────────────────────────────────────────────────

/**
 * Classify a code change on the human ↔ AI spectrum.
 *
 * Decision tree:
 *   1. No session AND no completion events          → HUMAN_ONLY
 *   2. Session AND no subsequent edits              → AI_GENERATED
 *   3. Session AND subsequent edits exist           → survival-rate branching
 *      a. survival > 0.70  → AI_GENERATED_HUMAN_MODIFIED
 *      b. survival 0.30–0.70 → AI_ASSISTED
 *      c. survival < 0.30  → AI_ASSISTED (low ratio)
 *   4. Completion events only (no full session)     → AI_ASSISTED
 */
export function classifyAttribution(params: {
  initialDiff:       string;
  subsequentEdits:   Array<{ diff: string; timestamp: number; sessionActive: boolean }>;
  sessionDetected:   boolean;
  completionEvents:  number;
  totalLinesChanged: number;
}): ClassificationResult {
  const {
    initialDiff,
    subsequentEdits,
    sessionDetected,
    completionEvents,
    totalLinesChanged,
  } = params;

  // ── Case 1: purely human ───────────────────────────────────────────────────
  if (!sessionDetected && completionEvents === 0) {
    return {
      classification:     AttributionClass.HUMAN_ONLY,
      aiRatio:            0,
      originalAIDiff:     null,
      humanModifications: null,
      reasoning:          [
        'No AI session was detected during these changes',
        'No inline completion acceptance events were recorded',
        'Changes are attributed to human authorship',
      ],
    };
  }

  // ── Case 4: completion events only, no full session ───────────────────────
  if (!sessionDetected && completionEvents > 0) {
    const ratio = round2(
      Math.min(1, completionEvents / Math.max(1, totalLinesChanged)),
    );
    return {
      classification:     AttributionClass.AI_ASSISTED,
      aiRatio:            ratio,
      originalAIDiff:     null,
      humanModifications: initialDiff || null,
      reasoning:          [
        `${completionEvents} inline completion acceptance event(s) were detected`,
        `No full AI session was active — human directed the overall change`,
        `Estimated AI ratio: ${pct(ratio)} (completions / total lines changed)`,
      ],
    };
  }

  // ── Cases 2 & 3: a full AI session was active ─────────────────────────────

  // Case 2: AI wrote it and nothing was edited afterward
  if (subsequentEdits.length === 0) {
    return {
      classification:     AttributionClass.AI_GENERATED,
      aiRatio:            1.0,
      originalAIDiff:     initialDiff || null,
      humanModifications: null,
      reasoning:          [
        'An AI session was active when these changes were made',
        'No subsequent human edits were detected after the AI output',
        'Code is attributed as AI-generated',
      ],
    };
  }

  // Case 3: AI wrote a first version, human then edited it
  // Measure survival against the union of all added lines across all subsequent edits
  const combinedModified = subsequentEdits.map(e => e.diff).join('\n');
  const survival = diffSurvivalRate(initialDiff, combinedModified);

  const humanModifications = combinedModified || null;

  if (survival > 0.70) {
    // Most of the AI output survived → AI_GENERATED_HUMAN_MODIFIED
    const aiRatio = round2(0.70 + (survival - 0.70) / 0.30 * 0.25); // maps [0.70,1.0] → [0.70,0.95]
    return {
      classification:     AttributionClass.AI_GENERATED_HUMAN_MODIFIED,
      aiRatio:            Math.min(0.95, aiRatio),
      originalAIDiff:     initialDiff || null,
      humanModifications,
      reasoning:          [
        `AI session was active and produced the initial change`,
        `${pct(survival)} of the original AI-generated lines survived subsequent edits`,
        'Human made minor refinements; AI output is the dominant contribution',
        `Estimated AI ratio: ${pct(Math.min(0.95, aiRatio))}`,
      ],
    };
  }

  if (survival >= 0.30) {
    // Moderate survival → AI_ASSISTED (mid range)
    const aiRatio = round2(0.30 + (survival - 0.30) / 0.40 * 0.40); // maps [0.30,0.70] → [0.30,0.70]
    return {
      classification:     AttributionClass.AI_ASSISTED,
      aiRatio,
      originalAIDiff:     initialDiff || null,
      humanModifications,
      reasoning:          [
        'AI session was active but the human significantly reworked the AI output',
        `${pct(survival)} of the original AI-generated lines survived subsequent edits`,
        'Collaboration is roughly balanced between AI suggestion and human refinement',
        `Estimated AI ratio: ${pct(aiRatio)}`,
      ],
    };
  }

  // Low survival → AI_ASSISTED (low AI ratio)
  const aiRatio = round2(0.10 + survival / 0.30 * 0.20); // maps [0,0.30] → [0.10,0.30]
  return {
    classification:     AttributionClass.AI_ASSISTED,
    aiRatio,
    originalAIDiff:     initialDiff || null,
    humanModifications,
    reasoning:          [
      'AI session was active, but fewer than 30% of original AI lines survived human editing',
      `${pct(survival)} survival rate — human heavily rewrote the AI-generated draft`,
      'AI contribution is mainly structural scaffolding; human wrote the substance',
      `Estimated AI ratio: ${pct(aiRatio)}`,
    ],
  };
}

// ── Internal helpers ───────────────────────────────────────────────────────────

/**
 * Extract the unique set of added lines from a unified diff.
 * Lines beginning with `+` are added; the `+++` file header is excluded.
 * The leading `+` is stripped before adding to the set.
 */
function extractAddedLines(diffText: string): Set<string> {
  const lines = new Set<string>();
  for (const raw of diffText.split('\n')) {
    if (raw.startsWith('+++ ')) continue;
    if (raw.startsWith('+')) lines.add(raw.slice(1));
  }
  return lines;
}

function round2(n: number): number {
  return Math.round(Math.min(1, Math.max(0, n)) * 100) / 100;
}

function pct(n: number): string {
  return (n * 100).toFixed(0) + '%';
}
