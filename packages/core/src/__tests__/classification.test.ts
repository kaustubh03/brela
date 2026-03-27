import { describe, it, expect } from 'vitest';
import { classifyAttribution, diffSurvivalRate, AttributionClass } from '../classification.js';

// ── Diff fixtures ─────────────────────────────────────────────────────────────

/** 10 added lines — a representative AI-generated function. */
const AI_DIFF = `\
--- a/src/auth.ts
+++ b/src/auth.ts
@@ -0,0 +1,10 @@
+export function verifyToken(token: string): boolean {
+  if (!token) return false;
+  const parts = token.split('.');
+  if (parts.length !== 3) return false;
+  try {
+    const payload = JSON.parse(atob(parts[1]!));
+    return Date.now() < payload.exp * 1000;
+  } catch {
+    return false;
+  }
+}
`;

/** 7 of the 10 lines unchanged — high survival scenario. */
const MODIFIED_HIGH = `\
--- a/src/auth.ts
+++ b/src/auth.ts
@@ -0,0 +1,10 @@
+export function verifyToken(token: string): boolean {
+  if (!token) return false;
+  const parts = token.split('.');
+  if (parts.length !== 3) return false;
+  try {
+    const payload = JSON.parse(atob(parts[1]!));
+    return Date.now() < payload.exp * 1000;
+  } catch (err) {
+    console.error(err);
+    return false;
+  }
+}
`;

/** 5 of the 10 original lines survive — mid survival. */
const MODIFIED_MID = `\
--- a/src/auth.ts
+++ b/src/auth.ts
@@ -0,0 +1,8 @@
+export function verifyToken(token: string): boolean {
+  if (!token) return false;
+  const parts = token.split('.');
+  if (parts.length !== 3) return false;
+  const decoded = decodeJwt(parts[1]!);
+  return decoded !== null && decoded.exp > Date.now() / 1000;
+}
`;

/** Only 2 of the 10 original lines survive — low survival. */
const MODIFIED_LOW = `\
--- a/src/auth.ts
+++ b/src/auth.ts
@@ -0,0 +1,6 @@
+export function verifyToken(token: string): boolean {
+  if (!token) return false;
+  return validateJWT(token, process.env['JWT_SECRET']!);
+}
`;

const NO_SESSION_PARAMS = {
  initialDiff:      AI_DIFF,
  subsequentEdits:  [],
  sessionDetected:  false,
  completionEvents: 0,
  totalLinesChanged: 10,
};

// ── diffSurvivalRate ──────────────────────────────────────────────────────────

describe('diffSurvivalRate', () => {
  it('returns 1.0 when modified is identical to original', () => {
    expect(diffSurvivalRate(AI_DIFF, AI_DIFF)).toBe(1);
  });

  it('returns 0 when original has no added lines', () => {
    const noAdded = '--- a/foo\n+++ b/foo\n-removed line\n';
    expect(diffSurvivalRate(noAdded, AI_DIFF)).toBe(0);
  });

  it('returns 0 when none of the original lines appear in modified', () => {
    const unrelated = '+completely different line one\n+completely different line two\n';
    expect(diffSurvivalRate(AI_DIFF, unrelated)).toBe(0);
  });

  it('correctly counts partial survival', () => {
    // MODIFIED_HIGH keeps 7 of the 10 original lines
    const rate = diffSurvivalRate(AI_DIFF, MODIFIED_HIGH);
    expect(rate).toBeGreaterThan(0.6);
    expect(rate).toBeLessThanOrEqual(1);
  });

  it('excludes +++ header lines from the added-line set', () => {
    const withHeader = '+++ b/src/auth.ts\n+real added line\n';
    const rate = diffSurvivalRate(withHeader, '+real added line\n');
    expect(rate).toBe(1); // only "real added line" is in the set
  });

  it('treats duplicate added lines as a single entry (set semantics)', () => {
    const dupe = '+same line\n+same line\n';
    const rate = diffSurvivalRate(dupe, '+same line\n');
    expect(rate).toBe(1); // set has one entry; it's present in modified
  });
});

// ── HUMAN_ONLY ────────────────────────────────────────────────────────────────

describe('classifyAttribution — HUMAN_ONLY', () => {
  it('returns HUMAN_ONLY when no session and no completions', () => {
    const result = classifyAttribution(NO_SESSION_PARAMS);
    expect(result.classification).toBe(AttributionClass.HUMAN_ONLY);
  });

  it('sets aiRatio to 0', () => {
    expect(classifyAttribution(NO_SESSION_PARAMS).aiRatio).toBe(0);
  });

  it('sets originalAIDiff and humanModifications to null', () => {
    const { originalAIDiff, humanModifications } = classifyAttribution(NO_SESSION_PARAMS);
    expect(originalAIDiff).toBeNull();
    expect(humanModifications).toBeNull();
  });

  it('reasoning mentions no AI session and no completions', () => {
    const { reasoning } = classifyAttribution(NO_SESSION_PARAMS);
    expect(reasoning.some(r => /session/i.test(r))).toBe(true);
    expect(reasoning.some(r => /completion/i.test(r))).toBe(true);
  });

  it('subsequentEdits are ignored when session=false and completions=0', () => {
    const result = classifyAttribution({
      ...NO_SESSION_PARAMS,
      subsequentEdits: [{ diff: MODIFIED_HIGH, timestamp: Date.now(), sessionActive: false }],
    });
    expect(result.classification).toBe(AttributionClass.HUMAN_ONLY);
  });
});

// ── AI_GENERATED ──────────────────────────────────────────────────────────────

describe('classifyAttribution — AI_GENERATED', () => {
  const base = { ...NO_SESSION_PARAMS, sessionDetected: true };

  it('returns AI_GENERATED when session detected and no subsequent edits', () => {
    const result = classifyAttribution(base);
    expect(result.classification).toBe(AttributionClass.AI_GENERATED);
  });

  it('sets aiRatio to 1.0', () => {
    expect(classifyAttribution(base).aiRatio).toBe(1.0);
  });

  it('stores the initialDiff as originalAIDiff', () => {
    expect(classifyAttribution(base).originalAIDiff).toBe(AI_DIFF);
  });

  it('humanModifications is null', () => {
    expect(classifyAttribution(base).humanModifications).toBeNull();
  });

  it('reasoning mentions AI session and no subsequent edits', () => {
    const { reasoning } = classifyAttribution(base);
    expect(reasoning.some(r => /session/i.test(r))).toBe(true);
    expect(reasoning.some(r => /subsequent|edit/i.test(r))).toBe(true);
  });
});

// ── AI_GENERATED_HUMAN_MODIFIED ───────────────────────────────────────────────

describe('classifyAttribution — AI_GENERATED_HUMAN_MODIFIED (survival > 70%)', () => {
  const base = {
    ...NO_SESSION_PARAMS,
    sessionDetected:  true,
    subsequentEdits:  [{ diff: MODIFIED_HIGH, timestamp: Date.now(), sessionActive: false }],
  };

  it('returns AI_GENERATED_HUMAN_MODIFIED for high-survival edits', () => {
    const result = classifyAttribution(base);
    expect(result.classification).toBe(AttributionClass.AI_GENERATED_HUMAN_MODIFIED);
  });

  it('aiRatio is between 0.70 and 0.95', () => {
    const { aiRatio } = classifyAttribution(base);
    expect(aiRatio).toBeGreaterThanOrEqual(0.70);
    expect(aiRatio).toBeLessThanOrEqual(0.95);
  });

  it('originalAIDiff is the initialDiff', () => {
    expect(classifyAttribution(base).originalAIDiff).toBe(AI_DIFF);
  });

  it('humanModifications is set', () => {
    expect(classifyAttribution(base).humanModifications).not.toBeNull();
  });

  it('reasoning mentions survival rate and AI dominance', () => {
    const { reasoning } = classifyAttribution(base);
    expect(reasoning.some(r => /surviv/i.test(r))).toBe(true);
    expect(reasoning.some(r => /AI/i.test(r))).toBe(true);
  });

  it('100% survival → aiRatio === 0.95 (capped)', () => {
    const result = classifyAttribution({
      ...base,
      subsequentEdits: [{ diff: AI_DIFF, timestamp: Date.now(), sessionActive: false }],
    });
    expect(result.classification).toBe(AttributionClass.AI_GENERATED_HUMAN_MODIFIED);
    expect(result.aiRatio).toBe(0.95);
  });
});

// ── AI_ASSISTED — mid survival ────────────────────────────────────────────────

describe('classifyAttribution — AI_ASSISTED (survival 30–70%)', () => {
  const base = {
    ...NO_SESSION_PARAMS,
    sessionDetected: true,
    subsequentEdits: [{ diff: MODIFIED_MID, timestamp: Date.now(), sessionActive: false }],
  };

  it('returns AI_ASSISTED for mid-range survival', () => {
    const result = classifyAttribution(base);
    expect(result.classification).toBe(AttributionClass.AI_ASSISTED);
  });

  it('aiRatio is between 0.30 and 0.70', () => {
    const { aiRatio } = classifyAttribution(base);
    expect(aiRatio).toBeGreaterThanOrEqual(0.30);
    expect(aiRatio).toBeLessThanOrEqual(0.70);
  });

  it('reasoning mentions balanced collaboration', () => {
    const { reasoning } = classifyAttribution(base);
    expect(reasoning.some(r => /balance|collaboration|rework/i.test(r))).toBe(true);
  });
});

// ── AI_ASSISTED — low survival ────────────────────────────────────────────────

describe('classifyAttribution — AI_ASSISTED (survival < 30%)', () => {
  const base = {
    ...NO_SESSION_PARAMS,
    sessionDetected: true,
    subsequentEdits: [{ diff: MODIFIED_LOW, timestamp: Date.now(), sessionActive: false }],
  };

  it('returns AI_ASSISTED for low survival', () => {
    const result = classifyAttribution(base);
    expect(result.classification).toBe(AttributionClass.AI_ASSISTED);
  });

  it('aiRatio is between 0.10 and 0.30', () => {
    const { aiRatio } = classifyAttribution(base);
    expect(aiRatio).toBeGreaterThanOrEqual(0.10);
    expect(aiRatio).toBeLessThanOrEqual(0.30);
  });

  it('reasoning mentions human heavy rewrite', () => {
    const { reasoning } = classifyAttribution(base);
    expect(reasoning.some(r => /rewrite|rewrote|heavy/i.test(r))).toBe(true);
  });

  it('0% survival → aiRatio is 0.10 (floor)', () => {
    const unrelated = '+totally unrelated line\n+another unrelated line\n';
    const result = classifyAttribution({
      ...base,
      subsequentEdits: [{ diff: unrelated, timestamp: Date.now(), sessionActive: false }],
    });
    expect(result.aiRatio).toBe(0.10);
  });
});

// ── AI_ASSISTED — completion events only ─────────────────────────────────────

describe('classifyAttribution — AI_ASSISTED (completion events, no session)', () => {
  it('returns AI_ASSISTED when completionEvents > 0 and no session', () => {
    const result = classifyAttribution({
      ...NO_SESSION_PARAMS,
      completionEvents:  3,
      totalLinesChanged: 20,
    });
    expect(result.classification).toBe(AttributionClass.AI_ASSISTED);
  });

  it('aiRatio = completionEvents / totalLinesChanged (capped at 1)', () => {
    const result = classifyAttribution({
      ...NO_SESSION_PARAMS,
      completionEvents:  5,
      totalLinesChanged: 20,
    });
    expect(result.aiRatio).toBe(0.25);
  });

  it('aiRatio is capped at 1 when completions > totalLinesChanged', () => {
    const result = classifyAttribution({
      ...NO_SESSION_PARAMS,
      completionEvents:  50,
      totalLinesChanged: 10,
    });
    expect(result.aiRatio).toBe(1);
  });

  it('handles totalLinesChanged === 0 without dividing by zero', () => {
    const result = classifyAttribution({
      ...NO_SESSION_PARAMS,
      completionEvents:  1,
      totalLinesChanged: 0,
    });
    expect(result.aiRatio).toBeGreaterThanOrEqual(0);
    expect(result.aiRatio).toBeLessThanOrEqual(1);
  });

  it('originalAIDiff is null (no session, no AI diff)', () => {
    const result = classifyAttribution({
      ...NO_SESSION_PARAMS,
      completionEvents: 2,
      totalLinesChanged: 10,
    });
    expect(result.originalAIDiff).toBeNull();
  });

  it('reasoning mentions completion events', () => {
    const result = classifyAttribution({
      ...NO_SESSION_PARAMS,
      completionEvents:  3,
      totalLinesChanged: 10,
    });
    expect(result.reasoning.some(r => /completion/i.test(r))).toBe(true);
  });
});

// ── Edge cases ────────────────────────────────────────────────────────────────

describe('edge cases', () => {
  it('multiple subsequent edits are all considered for survival', () => {
    // Each edit contributes some lines from the original
    const edit1 = { diff: MODIFIED_LOW, timestamp: Date.now(),     sessionActive: false };
    const edit2 = { diff: MODIFIED_HIGH, timestamp: Date.now() + 1, sessionActive: false };
    const result = classifyAttribution({
      ...NO_SESSION_PARAMS,
      sessionDetected: true,
      subsequentEdits: [edit1, edit2],
    });
    // Combined, MODIFIED_HIGH keeps many original lines, so survival should be high
    expect(result.classification).toBe(AttributionClass.AI_GENERATED_HUMAN_MODIFIED);
  });

  it('aiRatio is always in [0, 1]', () => {
    const cases = [
      NO_SESSION_PARAMS,
      { ...NO_SESSION_PARAMS, sessionDetected: true },
      { ...NO_SESSION_PARAMS, sessionDetected: true, subsequentEdits: [{ diff: MODIFIED_HIGH, timestamp: 0, sessionActive: false }] },
      { ...NO_SESSION_PARAMS, sessionDetected: true, subsequentEdits: [{ diff: MODIFIED_LOW, timestamp: 0, sessionActive: false }] },
      { ...NO_SESSION_PARAMS, completionEvents: 3, totalLinesChanged: 10 },
    ];
    for (const p of cases) {
      const { aiRatio } = classifyAttribution(p);
      expect(aiRatio).toBeGreaterThanOrEqual(0);
      expect(aiRatio).toBeLessThanOrEqual(1);
    }
  });

  it('reasoning is never empty', () => {
    const cases = [
      NO_SESSION_PARAMS,
      { ...NO_SESSION_PARAMS, sessionDetected: true },
      { ...NO_SESSION_PARAMS, completionEvents: 1, totalLinesChanged: 5 },
    ];
    for (const p of cases) {
      expect(classifyAttribution(p).reasoning.length).toBeGreaterThan(0);
    }
  });
});
