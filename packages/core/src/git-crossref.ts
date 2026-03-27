import { simpleGit } from 'simple-git';

// ── Public interfaces ──────────────────────────────────────────────────────────

export interface CrossValidationResult {
  filePath:                  string;
  lineRange:                 { start: number; end: number };
  attributionTimestamp:      number;
  gitBlameCommitTimestamp:   number;
  timeDeltaMs:               number;
  commitHash:                string;
  commitAuthor:              string;
  /** Lines in the range whose blame commit is within 5 min of attributionTimestamp. */
  linesMatchAttribution:     number;
  /** Lines in the range whose blame commit is more than 5 min AFTER attributionTimestamp. */
  linesModifiedLater:        number;
  status:                    'confirmed' | 'modified_since' | 'mismatch';
  details:                   string;
}

// ── Constants ──────────────────────────────────────────────────────────────────

/** Attribution is "confirmed" if the blame commit lands within this window. */
const CONFIRM_WINDOW_MS = 5 * 60 * 1_000; // 5 minutes

// ── Blame parser ───────────────────────────────────────────────────────────────

interface BlameLine {
  commitHash: string;
  authorName: string;
  /** Unix seconds (as reported by git). */
  authorTimeSec: number;
}

/**
 * Parse `git blame --porcelain -L <start>,<end>` output into per-line records.
 *
 * Porcelain format (first occurrence of a commit in the output):
 *   <hash> <orig-line> <result-line> <num-lines>
 *   author <name>
 *   author-time <unix-sec>
 *   …
 *   filename <path>
 *   \t<line-content>
 *
 * Subsequent lines belonging to the same commit only repeat the header line
 * (no `author` / `author-time` block), so we cache the metadata per hash.
 */
function parsePorcelainBlame(output: string): BlameLine[] {
  const lines = output.split('\n');
  const metaCache = new Map<string, { authorName: string; authorTimeSec: number }>();
  const result: BlameLine[] = [];

  let currentHash = '';
  let currentAuthor = '';
  let currentTimeSec = 0;

  for (const raw of lines) {
    // Header line: 40-char hex + space + up to 3 numeric fields
    if (/^[0-9a-f]{40} \d/.test(raw)) {
      currentHash = raw.slice(0, 40);
      const cached = metaCache.get(currentHash);
      if (cached) {
        currentAuthor   = cached.authorName;
        currentTimeSec  = cached.authorTimeSec;
      } else {
        // Reset; will be populated by author/author-time lines that follow
        currentAuthor  = '';
        currentTimeSec = 0;
      }
      continue;
    }

    if (raw.startsWith('author ') && !raw.startsWith('author-')) {
      currentAuthor = raw.slice(7);
      continue;
    }

    if (raw.startsWith('author-time ')) {
      currentTimeSec = parseInt(raw.slice(12), 10);
      // Cache so repeated occurrences of the same hash don't need re-parsing
      metaCache.set(currentHash, { authorName: currentAuthor, authorTimeSec: currentTimeSec });
      continue;
    }

    // Tab-prefixed line = actual source line → emit a BlameLine for it
    if (raw.startsWith('\t') && currentHash) {
      result.push({
        commitHash:    currentHash,
        authorName:    currentAuthor,
        authorTimeSec: currentTimeSec,
      });
    }
  }

  return result;
}

// ── crossValidateWithBlame ─────────────────────────────────────────────────────

/**
 * Run `git blame --porcelain` on a line range and cross-check whether the
 * commit that owns the majority of those lines falls within 5 minutes of
 * the recorded attribution timestamp.
 */
export async function crossValidateWithBlame(params: {
  repoPath:             string;
  filePath:             string;
  lineRange:            { start: number; end: number };
  attributionTimestamp: number;
  expectedAITool:       string;
}): Promise<CrossValidationResult> {
  const { repoPath, filePath, lineRange, attributionTimestamp } = params;
  const { start, end } = lineRange;

  const git = simpleGit(repoPath);

  const raw = await git.raw([
    'blame', '--porcelain',
    '-L', `${start},${end}`,
    '--',
    filePath,
  ]);

  const blamed = parsePorcelainBlame(raw);

  if (blamed.length === 0) {
    return _mismatch(params, 0, '', '', 'git blame returned no lines for the specified range');
  }

  // ── Find majority commit ───────────────────────────────────────────────────
  const counts = new Map<string, number>();
  for (const b of blamed) {
    counts.set(b.commitHash, (counts.get(b.commitHash) ?? 0) + 1);
  }

  let majorityHash = '';
  let majorityCount = 0;
  for (const [hash, count] of counts) {
    if (count > majorityCount) { majorityHash = hash; majorityCount = count; }
  }

  const majorityMeta = blamed.find(b => b.commitHash === majorityHash)!;
  const blameTimestampMs  = majorityMeta.authorTimeSec * 1_000;
  const timeDeltaMs       = Math.abs(blameTimestampMs - attributionTimestamp);

  // ── Classify each line ─────────────────────────────────────────────────────
  let linesMatchAttribution = 0;
  let linesModifiedLater    = 0;

  for (const b of blamed) {
    const bMs = b.authorTimeSec * 1_000;
    if (Math.abs(bMs - attributionTimestamp) <= CONFIRM_WINDOW_MS) {
      linesMatchAttribution++;
    } else if (bMs > attributionTimestamp + CONFIRM_WINDOW_MS) {
      linesModifiedLater++;
    }
  }

  const base: Omit<CrossValidationResult, 'status' | 'details'> = {
    filePath,
    lineRange,
    attributionTimestamp,
    gitBlameCommitTimestamp: blameTimestampMs,
    timeDeltaMs,
    commitHash:   majorityHash,
    commitAuthor: majorityMeta.authorName,
    linesMatchAttribution,
    linesModifiedLater,
  };

  // ── Verdict ────────────────────────────────────────────────────────────────
  const majority = linesMatchAttribution > blamed.length / 2;

  if (!majority) {
    return {
      ...base,
      status:  'mismatch',
      details: `Only ${linesMatchAttribution}/${blamed.length} lines fall within the 5-minute attribution window (delta: ${(timeDeltaMs / 1_000).toFixed(0)}s)`,
    };
  }

  if (linesModifiedLater > 0) {
    return {
      ...base,
      status:  'modified_since',
      details: `${linesMatchAttribution} line(s) confirmed; ${linesModifiedLater} line(s) subsequently modified after the attributed timestamp`,
    };
  }

  return {
    ...base,
    status:  'confirmed',
    details: `${linesMatchAttribution}/${blamed.length} lines attributed to commit ${majorityHash.slice(0, 8)} within ${(timeDeltaMs / 1_000).toFixed(0)}s of the recorded timestamp`,
  };
}

// ── batchCrossValidate ─────────────────────────────────────────────────────────

/**
 * Run `crossValidateWithBlame` for every entry in `attributions`.
 * Per-file errors are caught and returned as `'mismatch'` records so a single
 * bad file does not abort the whole batch.
 */
export async function batchCrossValidate(params: {
  repoPath:     string;
  attributions: Array<{
    filePath:   string;
    lineRange:  { start: number; end: number };
    timestamp:  number;
    aiTool:     string;
  }>;
}): Promise<CrossValidationResult[]> {
  const { repoPath, attributions } = params;

  const results = await Promise.allSettled(
    attributions.map(a =>
      crossValidateWithBlame({
        repoPath,
        filePath:             a.filePath,
        lineRange:            a.lineRange,
        attributionTimestamp: a.timestamp,
        expectedAITool:       a.aiTool,
      }),
    ),
  );

  return results.map((settled, i) => {
    if (settled.status === 'fulfilled') return settled.value;

    const a = attributions[i]!;
    const err = settled.reason instanceof Error ? settled.reason.message : String(settled.reason);
    return _mismatch(
      { filePath: a.filePath, lineRange: a.lineRange, attributionTimestamp: a.timestamp },
      a.timestamp,
      '',
      '',
      `Error running git blame: ${err}`,
    );
  });
}

// ── Internal helpers ───────────────────────────────────────────────────────────

function _mismatch(
  params:         { filePath: string; lineRange: { start: number; end: number }; attributionTimestamp: number },
  blameTimestamp: number,
  hash:           string,
  author:         string,
  details:        string,
): CrossValidationResult {
  return {
    filePath:                  params.filePath,
    lineRange:                 params.lineRange,
    attributionTimestamp:      params.attributionTimestamp,
    gitBlameCommitTimestamp:   blameTimestamp,
    timeDeltaMs:               Math.abs(blameTimestamp - params.attributionTimestamp),
    commitHash:                hash,
    commitAuthor:              author,
    linesMatchAttribution:     0,
    linesModifiedLater:        0,
    status:                    'mismatch',
    details,
  };
}
