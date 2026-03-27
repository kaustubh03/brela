import { describe, it, expect, vi, beforeEach } from 'vitest';
import { crossValidateWithBlame, batchCrossValidate } from '../git-crossref.js';

// ── Mock simple-git ────────────────────────────────────────────────────────────

vi.mock('simple-git', () => {
  const rawMock = vi.fn();
  const gitInstance = { raw: rawMock };
  return { simpleGit: vi.fn(() => gitInstance), _rawMock: rawMock };
});

/** Grab the underlying vi.fn() so individual tests can set return values. */
async function getRawMock(): Promise<ReturnType<typeof vi.fn>> {
  const mod = await import('simple-git');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (mod as any)._rawMock as ReturnType<typeof vi.fn>;
}

// ── Porcelain blame builders ───────────────────────────────────────────────────

const HASH_A = 'a'.repeat(40);
const HASH_B = 'b'.repeat(40);
const HASH_C = 'c'.repeat(40);

/**
 * Build a minimal git blame --porcelain block for a single commit.
 * The first entry includes the full metadata; subsequent lines for the same
 * commit only repeat the header line (matching real git output).
 */
function blameBlock(opts: {
  hash:        string;
  author:      string;
  authorTimeSec: number;
  origStart:   number;
  resultStart: number;
  count:       number;
  lines:       string[];
}): string {
  const { hash, author, authorTimeSec, origStart, resultStart, count, lines } = opts;
  const out: string[] = [];

  for (let i = 0; i < count; i++) {
    if (i === 0) {
      // First occurrence — full metadata block
      out.push(`${hash} ${origStart + i} ${resultStart + i} ${count}`);
      out.push(`author ${author}`);
      out.push(`author-mail <${author.toLowerCase().replace(' ', '.')}@example.com>`);
      out.push(`author-time ${authorTimeSec}`);
      out.push(`author-tz +0000`);
      out.push(`committer ${author}`);
      out.push(`committer-mail <${author.toLowerCase().replace(' ', '.')}@example.com>`);
      out.push(`committer-time ${authorTimeSec}`);
      out.push(`committer-tz +0000`);
      out.push(`summary ai-generated change`);
      out.push(`filename src/auth.ts`);
    } else {
      // Subsequent lines in same group — header only, no metadata repeated
      out.push(`${hash} ${origStart + i} ${resultStart + i}`);
    }
    out.push(`\t${lines[i] ?? `line ${resultStart + i}`}`);
  }
  return out.join('\n');
}

// ── Attribution timestamp fixtures ────────────────────────────────────────────

const ATTR_TS_MS     = 1_700_000_000_000; // baseline attribution time
const ATTR_TS_SEC    = ATTR_TS_MS / 1_000;

// A commit within the 5-minute confirmation window (+2 min)
const WITHIN_WINDOW_SEC = ATTR_TS_SEC + 120;

// A commit after the 5-minute window (+10 min → "modified later")
const AFTER_WINDOW_SEC  = ATTR_TS_SEC + 600;

// A commit well before the attribution time (−30 min → mismatch)
const BEFORE_ATTR_SEC   = ATTR_TS_SEC - 1_800;

const BASE_PARAMS = {
  repoPath:             '/repo',
  filePath:             'src/auth.ts',
  lineRange:            { start: 1, end: 5 },
  attributionTimestamp: ATTR_TS_MS,
  expectedAITool:       'COPILOT',
};

// ── confirmed ─────────────────────────────────────────────────────────────────

describe('crossValidateWithBlame — confirmed', () => {
  beforeEach(async () => {
    const raw = await getRawMock();
    // All 5 lines owned by a single commit within the 5-minute window
    raw.mockResolvedValue(
      blameBlock({
        hash:          HASH_A,
        author:        'AI Bot',
        authorTimeSec: WITHIN_WINDOW_SEC,
        origStart:     1, resultStart: 1, count: 5,
        lines:         ['line1', 'line2', 'line3', 'line4', 'line5'],
      }),
    );
  });

  it('returns status confirmed', async () => {
    const result = await crossValidateWithBlame(BASE_PARAMS);
    expect(result.status).toBe('confirmed');
  });

  it('linesMatchAttribution equals total lines (5)', async () => {
    const result = await crossValidateWithBlame(BASE_PARAMS);
    expect(result.linesMatchAttribution).toBe(5);
  });

  it('linesModifiedLater is 0', async () => {
    expect((await crossValidateWithBlame(BASE_PARAMS)).linesModifiedLater).toBe(0);
  });

  it('commitHash matches the blame hash', async () => {
    expect((await crossValidateWithBlame(BASE_PARAMS)).commitHash).toBe(HASH_A);
  });

  it('commitAuthor is populated', async () => {
    expect((await crossValidateWithBlame(BASE_PARAMS)).commitAuthor).toBe('AI Bot');
  });

  it('gitBlameCommitTimestamp is within 5 min of attributionTimestamp', async () => {
    const result = await crossValidateWithBlame(BASE_PARAMS);
    expect(result.timeDeltaMs).toBeLessThanOrEqual(5 * 60 * 1_000);
  });

  it('details mention the commit hash prefix', async () => {
    const result = await crossValidateWithBlame(BASE_PARAMS);
    expect(result.details).toContain(HASH_A.slice(0, 8));
  });

  it('filePath and lineRange are echoed back', async () => {
    const result = await crossValidateWithBlame(BASE_PARAMS);
    expect(result.filePath).toBe(BASE_PARAMS.filePath);
    expect(result.lineRange).toEqual(BASE_PARAMS.lineRange);
  });
});

// ── modified_since ────────────────────────────────────────────────────────────

describe('crossValidateWithBlame — modified_since', () => {
  beforeEach(async () => {
    const raw = await getRawMock();
    // Lines 1-3: within window (original AI commit)
    // Lines 4-5: after window (human edited later)
    const block1 = blameBlock({
      hash: HASH_A, author: 'AI Bot', authorTimeSec: WITHIN_WINDOW_SEC,
      origStart: 1, resultStart: 1, count: 3,
      lines: ['line1', 'line2', 'line3'],
    });
    const block2 = blameBlock({
      hash: HASH_B, author: 'Human Dev', authorTimeSec: AFTER_WINDOW_SEC,
      origStart: 4, resultStart: 4, count: 2,
      lines: ['line4', 'line5'],
    });
    raw.mockResolvedValue(block1 + '\n' + block2);
  });

  it('returns status modified_since', async () => {
    const result = await crossValidateWithBlame(BASE_PARAMS);
    expect(result.status).toBe('modified_since');
  });

  it('linesMatchAttribution counts lines in the original window', async () => {
    const result = await crossValidateWithBlame(BASE_PARAMS);
    expect(result.linesMatchAttribution).toBe(3);
  });

  it('linesModifiedLater counts lines changed after the window', async () => {
    const result = await crossValidateWithBlame(BASE_PARAMS);
    expect(result.linesModifiedLater).toBe(2);
  });

  it('details mention both confirmed and modified counts', async () => {
    const result = await crossValidateWithBlame(BASE_PARAMS);
    expect(result.details).toMatch(/3.*line|confirmed/i);
    expect(result.details).toMatch(/2.*line|modif/i);
  });
});

// ── mismatch ──────────────────────────────────────────────────────────────────

describe('crossValidateWithBlame — mismatch', () => {
  it('returns mismatch when majority commit is far outside the 5-min window', async () => {
    const raw = await getRawMock();
    raw.mockResolvedValue(
      blameBlock({
        hash: HASH_C, author: 'Old Committer', authorTimeSec: BEFORE_ATTR_SEC,
        origStart: 1, resultStart: 1, count: 5,
        lines: ['l1', 'l2', 'l3', 'l4', 'l5'],
      }),
    );
    const result = await crossValidateWithBlame(BASE_PARAMS);
    expect(result.status).toBe('mismatch');
  });

  it('linesMatchAttribution is 0 on full mismatch', async () => {
    const raw = await getRawMock();
    raw.mockResolvedValue(
      blameBlock({
        hash: HASH_C, author: 'Old Committer', authorTimeSec: BEFORE_ATTR_SEC,
        origStart: 1, resultStart: 1, count: 5,
        lines: ['l1', 'l2', 'l3', 'l4', 'l5'],
      }),
    );
    expect((await crossValidateWithBlame(BASE_PARAMS)).linesMatchAttribution).toBe(0);
  });

  it('returns mismatch when git blame returns empty output', async () => {
    const raw = await getRawMock();
    raw.mockResolvedValue('');
    const result = await crossValidateWithBlame(BASE_PARAMS);
    expect(result.status).toBe('mismatch');
    expect(result.details).toMatch(/no lines/i);
  });

  it('details mention the time delta', async () => {
    const raw = await getRawMock();
    raw.mockResolvedValue(
      blameBlock({
        hash: HASH_C, author: 'Old Committer', authorTimeSec: BEFORE_ATTR_SEC,
        origStart: 1, resultStart: 1, count: 5,
        lines: ['l1', 'l2', 'l3', 'l4', 'l5'],
      }),
    );
    const result = await crossValidateWithBlame(BASE_PARAMS);
    expect(result.details).toMatch(/window|delta/i);
  });

  it('split blame where neither commit is the majority within the window', async () => {
    const raw = await getRawMock();
    // 3 lines from old commit (before window), 2 from within-window commit
    // → majority is the old commit → mismatch
    const block1 = blameBlock({
      hash: HASH_C, author: 'Old', authorTimeSec: BEFORE_ATTR_SEC,
      origStart: 1, resultStart: 1, count: 3, lines: ['a', 'b', 'c'],
    });
    const block2 = blameBlock({
      hash: HASH_A, author: 'AI Bot', authorTimeSec: WITHIN_WINDOW_SEC,
      origStart: 4, resultStart: 4, count: 2, lines: ['d', 'e'],
    });
    raw.mockResolvedValue(block1 + '\n' + block2);

    const result = await crossValidateWithBlame(BASE_PARAMS);
    expect(result.status).toBe('mismatch');
  });
});

// ── batchCrossValidate ────────────────────────────────────────────────────────

describe('batchCrossValidate', () => {
  it('returns one result per attribution', async () => {
    const raw = await getRawMock();
    raw.mockResolvedValue(
      blameBlock({
        hash: HASH_A, author: 'AI Bot', authorTimeSec: WITHIN_WINDOW_SEC,
        origStart: 1, resultStart: 1, count: 3, lines: ['a', 'b', 'c'],
      }),
    );

    const results = await batchCrossValidate({
      repoPath: '/repo',
      attributions: [
        { filePath: 'src/a.ts', lineRange: { start: 1, end: 3 }, timestamp: ATTR_TS_MS, aiTool: 'COPILOT' },
        { filePath: 'src/b.ts', lineRange: { start: 1, end: 3 }, timestamp: ATTR_TS_MS, aiTool: 'COPILOT' },
      ],
    });
    expect(results).toHaveLength(2);
  });

  it('returns confirmed for valid attributions in batch', async () => {
    const raw = await getRawMock();
    raw.mockResolvedValue(
      blameBlock({
        hash: HASH_A, author: 'AI Bot', authorTimeSec: WITHIN_WINDOW_SEC,
        origStart: 1, resultStart: 1, count: 3, lines: ['a', 'b', 'c'],
      }),
    );
    const results = await batchCrossValidate({
      repoPath: '/repo',
      attributions: [
        { filePath: 'src/a.ts', lineRange: { start: 1, end: 3 }, timestamp: ATTR_TS_MS, aiTool: 'COPILOT' },
      ],
    });
    expect(results[0]!.status).toBe('confirmed');
  });

  it('handles per-file errors gracefully — returns mismatch with error details', async () => {
    const raw = await getRawMock();
    raw.mockRejectedValue(new Error('fatal: no such path in HEAD'));

    const results = await batchCrossValidate({
      repoPath: '/repo',
      attributions: [
        { filePath: 'src/gone.ts', lineRange: { start: 1, end: 5 }, timestamp: ATTR_TS_MS, aiTool: 'COPILOT' },
      ],
    });

    expect(results).toHaveLength(1);
    expect(results[0]!.status).toBe('mismatch');
    expect(results[0]!.details).toMatch(/error|fatal/i);
  });

  it('a single file error does not abort the rest of the batch', async () => {
    const raw = await getRawMock();
    raw
      .mockRejectedValueOnce(new Error('no such file'))
      .mockResolvedValueOnce(
        blameBlock({
          hash: HASH_A, author: 'AI Bot', authorTimeSec: WITHIN_WINDOW_SEC,
          origStart: 1, resultStart: 1, count: 2, lines: ['x', 'y'],
        }),
      );

    const results = await batchCrossValidate({
      repoPath: '/repo',
      attributions: [
        { filePath: 'src/bad.ts',  lineRange: { start: 1, end: 2 }, timestamp: ATTR_TS_MS, aiTool: 'COPILOT' },
        { filePath: 'src/good.ts', lineRange: { start: 1, end: 2 }, timestamp: ATTR_TS_MS, aiTool: 'COPILOT' },
      ],
    });

    expect(results[0]!.status).toBe('mismatch');
    expect(results[1]!.status).toBe('confirmed');
  });

  it('returns empty array for empty attributions', async () => {
    const results = await batchCrossValidate({ repoPath: '/repo', attributions: [] });
    expect(results).toHaveLength(0);
  });
});

// ── timeDeltaMs ───────────────────────────────────────────────────────────────

describe('timeDeltaMs field', () => {
  it('is the absolute difference between attribution and blame timestamps', async () => {
    const raw = await getRawMock();
    raw.mockResolvedValue(
      blameBlock({
        hash: HASH_A, author: 'AI Bot', authorTimeSec: WITHIN_WINDOW_SEC,
        origStart: 1, resultStart: 1, count: 3, lines: ['a', 'b', 'c'],
      }),
    );
    const result = await crossValidateWithBlame(BASE_PARAMS);
    const expected = Math.abs(WITHIN_WINDOW_SEC * 1_000 - ATTR_TS_MS);
    expect(result.timeDeltaMs).toBe(expected);
  });
});
