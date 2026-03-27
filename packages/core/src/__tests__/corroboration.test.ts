import { describe, it, expect } from 'vitest';
import { corroborateAttribution, SIGNAL_WEIGHTS } from '../corroboration.js';
import { AITool, DetectionMethod } from '../types.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

function shell(tool = AITool.CLAUDE_CODE_AGENT) {
  return { method: DetectionMethod.SHELL_WRAPPER, tool };
}
function trailer(tool = AITool.CLAUDE_CODE_AGENT) {
  return { method: DetectionMethod.CO_AUTHOR_TRAILER, tool };
}
function watcher(tool = AITool.AIDER, sessionMatch = true) {
  return { method: DetectionMethod.FILE_WATCHER, tool, metadata: { sessionMatch } };
}
function large(tool = AITool.COPILOT) {
  return { method: DetectionMethod.LARGE_INSERTION, tool };
}
function burst(tool = AITool.COPILOT) {
  return { method: DetectionMethod.MULTI_FILE_BURST, tool };
}

// ── Edge case: empty input ────────────────────────────────────────────────────

describe('empty signals', () => {
  it('returns compositeScore 0, low confidence, and a single reasoning line', () => {
    const result = corroborateAttribution([]);
    expect(result.compositeScore).toBe(0);
    expect(result.confidence).toBe('low');
    expect(result.signals).toHaveLength(0);
    expect(result.reasoning).toHaveLength(1);
    expect(result.reasoning[0]).toMatch(/no signals/i);
  });
});

// ── Single signal ─────────────────────────────────────────────────────────────

describe('single signal', () => {
  it('SHELL_WRAPPER → score 0.85, high confidence', () => {
    const r = corroborateAttribution([shell()]);
    expect(r.compositeScore).toBeCloseTo(0.85, 3);
    expect(r.confidence).toBe('high');
    expect(r.signals).toHaveLength(1);
    expect(r.signals[0]!.weight).toBe(0.85);
  });

  it('CO_AUTHOR_TRAILER → score 0.80, high confidence', () => {
    const r = corroborateAttribution([trailer()]);
    expect(r.compositeScore).toBeCloseTo(0.80, 3);
    expect(r.confidence).toBe('high');
  });

  it('LARGE_INSERTION → score 0.40, low confidence', () => {
    const r = corroborateAttribution([large()]);
    expect(r.compositeScore).toBeCloseTo(0.40, 3);
    expect(r.confidence).toBe('low');
  });

  it('MULTI_FILE_BURST → score 0.45, medium confidence', () => {
    const r = corroborateAttribution([burst()]);
    expect(r.compositeScore).toBeCloseTo(0.45, 3);
    expect(r.confidence).toBe('medium');
  });

  it('MANUAL → score 1.0, high confidence', () => {
    const r = corroborateAttribution([{ method: DetectionMethod.MANUAL, tool: AITool.CURSOR }]);
    expect(r.compositeScore).toBeCloseTo(1.0, 3);
    expect(r.confidence).toBe('high');
  });

  it('FILE_WATCHER with sessionMatch:true uses full weight 0.70', () => {
    const r = corroborateAttribution([watcher(AITool.AIDER, true)]);
    expect(r.signals[0]!.weight).toBe(0.70);
    expect(r.compositeScore).toBeCloseTo(0.70, 3);
    expect(r.confidence).toBe('medium');
  });

  it('FILE_WATCHER without sessionMatch uses reduced weight 0.55', () => {
    const r = corroborateAttribution([
      { method: DetectionMethod.FILE_WATCHER, tool: AITool.AIDER },
    ]);
    expect(r.signals[0]!.weight).toBe(0.55);
    expect(r.compositeScore).toBeCloseTo(0.55, 3);
  });

  it('FILE_WATCHER with sessionMatch:false uses reduced weight 0.55', () => {
    const r = corroborateAttribution([watcher(AITool.AIDER, false)]);
    expect(r.signals[0]!.weight).toBe(0.55);
  });

  it('single signal never receives the agreement boost', () => {
    const single = corroborateAttribution([shell()]);
    expect(single.compositeScore).toBeCloseTo(0.85, 3); // not 0.95
    expect(single.reasoning.some((s) => /boost/i.test(s))).toBe(false);
  });

  it('reasoning contains exactly one line with the signal method', () => {
    const r = corroborateAttribution([shell()]);
    expect(r.reasoning).toHaveLength(1);
    expect(r.reasoning[0]).toContain(DetectionMethod.SHELL_WRAPPER);
  });
});

// ── Multiple agreeing signals ─────────────────────────────────────────────────

describe('multiple agreeing signals', () => {
  it('two strong signals produce a higher score than either alone (noisy-OR)', () => {
    // Expected: 1 - (1-0.85)*(1-0.80) = 1 - 0.03 = 0.97, then +0.10 → capped at 1.0
    const r = corroborateAttribution([shell(), trailer()]);
    expect(r.compositeScore).toBe(1.0);
    expect(r.confidence).toBe('high');
  });

  it('two weak agreeing signals receive the +0.10 tool-agreement boost', () => {
    const agree    = corroborateAttribution([large(), burst()]);       // same tool
    const conflict = corroborateAttribution([large(), burst(AITool.CODEIUM)]); // diff tool
    // agree:    noisy-OR = 1-(0.60)(0.55)=0.67, +0.10 = 0.77
    // conflict: noisy-OR = 0.67, no boost, confidence degraded
    expect(agree.compositeScore).toBeGreaterThan(conflict.compositeScore);
  });

  it('agreement boost is capped at 1.0', () => {
    const r = corroborateAttribution([
      { method: DetectionMethod.MANUAL,          tool: AITool.CLAUDE_CODE },
      { method: DetectionMethod.SHELL_WRAPPER,   tool: AITool.CLAUDE_CODE },
      { method: DetectionMethod.CO_AUTHOR_TRAILER, tool: AITool.CLAUDE_CODE },
    ]);
    expect(r.compositeScore).toBeLessThanOrEqual(1.0);
  });

  it('reasoning includes an agreement note when all tools match', () => {
    const r = corroborateAttribution([shell(), trailer()]);
    expect(r.reasoning.some((s) => /agree/i.test(s))).toBe(true);
  });

  it('each signal produces its own reasoning entry plus the agreement note', () => {
    const r = corroborateAttribution([shell(), trailer()]);
    // 2 signal lines + 1 agreement note
    expect(r.reasoning).toHaveLength(3);
  });

  it('FILE_WATCHER with sessionMatch contributes its 0.70 weight to composite', () => {
    const r = corroborateAttribution([
      shell(AITool.AIDER),
      watcher(AITool.AIDER, true),
    ]);
    // noisy-OR: 1 - (0.15)(0.30) = 0.955, +0.10 = 1.0 (capped)
    expect(r.compositeScore).toBe(1.0);
    expect(r.confidence).toBe('high');
  });

  it('metadata is preserved on ScoredSignal', () => {
    const r = corroborateAttribution([
      watcher(AITool.AIDER, true),
    ]);
    expect(r.signals[0]!.metadata['sessionMatch']).toBe(true);
  });
});

// ── Conflicting signals ───────────────────────────────────────────────────────

describe('conflicting signals', () => {
  it('conflicting tools degrade confidence by one tier', () => {
    // SHELL_WRAPPER alone → score 0.97, confidence high
    // Add conflicting tool → score 0.97 (no boost), confidence degraded to medium
    const r = corroborateAttribution([
      shell(AITool.CLAUDE_CODE_AGENT),
      trailer(AITool.COPILOT),
    ]);
    expect(r.confidence).toBe('medium');
  });

  it('conflict does not reduce compositeScore (only confidence tier)', () => {
    const conflict = corroborateAttribution([shell(AITool.CLAUDE_CODE_AGENT), trailer(AITool.COPILOT)]);
    // noisy-OR only, no tool boost
    const expected = 1 - (1 - 0.85) * (1 - 0.80);
    expect(conflict.compositeScore).toBeCloseTo(expected, 3);
  });

  it('reasoning contains a conflict note', () => {
    const r = corroborateAttribution([shell(AITool.CLAUDE_CODE_AGENT), trailer(AITool.COPILOT)]);
    expect(r.reasoning.some((s) => /conflict/i.test(s))).toBe(true);
  });

  it('conflict note lists all disagreeing tools', () => {
    const r = corroborateAttribution([
      shell(AITool.CLAUDE_CODE_AGENT),
      trailer(AITool.COPILOT),
    ]);
    const conflictLine = r.reasoning.find((s) => /conflict/i.test(s))!;
    expect(conflictLine).toContain(AITool.CLAUDE_CODE_AGENT);
    expect(conflictLine).toContain(AITool.COPILOT);
  });

  it('medium score with conflicting tools degrades to low confidence', () => {
    // LARGE_INSERTION + LARGE_INSERTION (diff tools): noisy-OR = 1-(0.60)(0.60) = 0.64 → medium
    // conflict degrades medium → low
    const r = corroborateAttribution([
      large(AITool.COPILOT),
      large(AITool.CURSOR),
    ]);
    expect(r.confidence).toBe('low');
  });

  it('low score with conflict stays low (cannot go below low)', () => {
    const r = corroborateAttribution([
      { method: DetectionMethod.LARGE_INSERTION, tool: AITool.COPILOT },
      { method: DetectionMethod.LARGE_INSERTION, tool: AITool.CURSOR },
    ]);
    expect(r.confidence).toBe('low');
  });

  it('conflict and no agreement boost are mutually exclusive from agreement boost', () => {
    const r = corroborateAttribution([shell(AITool.CLAUDE_CODE_AGENT), trailer(AITool.COPILOT)]);
    expect(r.reasoning.some((s) => /boost/i.test(s))).toBe(false);
  });
});

// ── SIGNAL_WEIGHTS export ─────────────────────────────────────────────────────

describe('SIGNAL_WEIGHTS', () => {
  it('contains an entry for every DetectionMethod value', () => {
    for (const method of Object.values(DetectionMethod)) {
      expect(SIGNAL_WEIGHTS[method]).toBeDefined();
    }
  });

  it('all weights are in the range (0, 1]', () => {
    for (const [method, w] of Object.entries(SIGNAL_WEIGHTS)) {
      expect(w).toBeGreaterThan(0);
      expect(w).toBeLessThanOrEqual(1);
      void method; // suppress unused-var lint
    }
  });

  it('MANUAL has the highest weight (1.0)', () => {
    expect(SIGNAL_WEIGHTS[DetectionMethod.MANUAL]).toBe(1.0);
  });

  it('LARGE_INSERTION has the lowest weight', () => {
    const min = Math.min(...Object.values(SIGNAL_WEIGHTS));
    expect(SIGNAL_WEIGHTS[DetectionMethod.LARGE_INSERTION]).toBe(min);
  });
});
