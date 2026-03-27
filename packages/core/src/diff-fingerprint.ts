// ── Public interface ──────────────────────────────────────────────────────────

export interface DiffFingerprint {
  linesAdded:          number;
  linesRemoved:        number;
  /** 0–1: how internally consistent indentation, semicolons, and quote style are. */
  coherenceScore:      number;
  /** 0–1: fraction of added lines that match common boilerplate patterns. */
  boilerplateRatio:    number;
  /** Comment lines per non-empty code line in the added block. */
  commentDensity:      number;
  /** 0–1: how uniformly variable names follow one naming convention. */
  namingConsistency:   number;
  /** 0–1: composite AI-likelihood estimate. */
  aiLikelihood:        number;
  /** Human-readable reasons each factor contributed above its threshold. */
  indicators:          string[];
}

// ── Diff parsing ──────────────────────────────────────────────────────────────

/**
 * Extract lines from a unified diff.
 * Added lines start with `+` (excluding the `+++` file header).
 * Removed lines start with `-` (excluding the `---` file header).
 * The leading `+` / `-` character is stripped from the returned strings.
 */
function parseDiff(diffText: string): { added: string[]; removed: string[] } {
  const added:   string[] = [];
  const removed: string[] = [];

  for (const raw of diffText.split('\n')) {
    if (raw.startsWith('+++ ') || raw.startsWith('--- ')) continue;
    if (raw.startsWith('+')) { added.push(raw.slice(1));   continue; }
    if (raw.startsWith('-')) { removed.push(raw.slice(1)); continue; }
  }

  return { added, removed };
}

// ── Language / style detection ────────────────────────────────────────────────

type Language = 'js_ts' | 'python' | 'other';

function detectLanguage(lines: string[]): Language {
  const sample = lines.slice(0, 40).join('\n');
  if (/\bdef \w+\(|^\s*#/.test(sample))        return 'python';
  if (/[;{}]|=>|import\s+\{|require\(/.test(sample)) return 'js_ts';
  return 'other';
}

// ── Coherence score ───────────────────────────────────────────────────────────

/**
 * Measures how internally self-consistent the added block is across three axes:
 *   – indentation character (tabs vs spaces)
 *   – semicolons at end-of-statement
 *   – string-literal quote style (single vs double)
 *
 * Each axis contributes 1/3 of the score.  An axis that has no relevant tokens
 * is treated as perfectly consistent (1.0) so that sparse diffs are not penalised.
 */
function computeCoherenceScore(lines: string[]): number {
  if (lines.length === 0) return 0;

  const nonEmpty = lines.filter(l => l.trim().length > 0);
  if (nonEmpty.length === 0) return 0;

  // ── Indentation consistency ───────────────────────────────────────────────
  let tabLines = 0, spaceLines = 0;
  for (const line of nonEmpty) {
    const match = /^(\s+)/.exec(line);
    if (!match) continue;
    if (match[1].includes('\t')) tabLines++; else spaceLines++;
  }
  const indentTotal = tabLines + spaceLines;
  const indentConsistency =
    indentTotal === 0 ? 1 : Math.max(tabLines, spaceLines) / indentTotal;

  // ── Semicolon consistency (JS/TS proxy) ──────────────────────────────────
  // Count statement-like lines (ending in ; or not) ignoring comments/blanks
  const stmtLines = nonEmpty.filter(l => {
    const t = l.trim();
    return t.length > 0 && !t.startsWith('//') && !t.startsWith('#') &&
           !t.startsWith('*') && !t.endsWith('{') && !t.endsWith('}') &&
           !t.endsWith(',') && !t.startsWith('import ') && t.length > 3;
  });
  let withSemi = 0, withoutSemi = 0;
  for (const line of stmtLines) {
    if (line.trimEnd().endsWith(';')) withSemi++; else withoutSemi++;
  }
  const semiTotal = withSemi + withoutSemi;
  const semiConsistency =
    semiTotal < 3 ? 1 : Math.max(withSemi, withoutSemi) / semiTotal;

  // ── Quote style consistency ───────────────────────────────────────────────
  const joined = nonEmpty.join('\n');
  const singleCount = (joined.match(/'/g) ?? []).length;
  const doubleCount = (joined.match(/"/g) ?? []).length;
  const quoteTotal  = singleCount + doubleCount;
  const quoteConsistency =
    quoteTotal < 4 ? 1 : Math.max(singleCount, doubleCount) / quoteTotal;

  return round3((indentConsistency + semiConsistency + quoteConsistency) / 3);
}

// ── Boilerplate patterns ──────────────────────────────────────────────────────

const BOILERPLATE_PATTERNS: RegExp[] = [
  // Import / require statements
  /^\s*(import\s|from\s+'|require\(|#include\s)/,
  // try / catch / finally blocks
  /^\s*(try\s*\{|catch\s*\(|finally\s*\{)/,
  // Null / undefined / error guard checks
  /^\s*if\s*\(.*?(===?\s*null|===?\s*undefined|instanceof\s+Error|!.*?)\)/,
  // Class / interface / constructor boilerplate
  /^\s*(export\s+)?(default\s+)?(abstract\s+)?(class|interface|enum)\s+\w/,
  /^\s*(public|private|protected|readonly)\s+(static\s+)?(\w+\s*[:(]|constructor)/,
  // Getter / setter
  /^\s*(get|set)\s+\w+\s*\(/,
  // Error throwing / return-null guards
  /^\s*(throw new |return null;|return undefined;)/,
  // Common logging
  /^\s*console\.(log|error|warn|debug)\s*\(/,
  // TypeScript type annotations / decorators
  /^\s*@\w+/,
  // JSDoc / block comment openers
  /^\s*\/\*\*/,
];

function computeBoilerplateRatio(lines: string[]): number {
  if (lines.length === 0) return 0;
  const count = lines.filter(l =>
    BOILERPLATE_PATTERNS.some(re => re.test(l)),
  ).length;
  return round3(count / lines.length);
}

// ── Comment density ───────────────────────────────────────────────────────────

function isCommentLine(line: string, lang: Language): boolean {
  const t = line.trim();
  if (t.startsWith('//') || t.startsWith('/*') || t.startsWith('*')) return true;
  if (lang === 'python' && t.startsWith('#')) return true;
  return false;
}

function computeCommentDensity(lines: string[], lang: Language): number {
  const nonEmpty = lines.filter(l => l.trim().length > 0);
  if (nonEmpty.length === 0) return 0;
  const commentLines = nonEmpty.filter(l => isCommentLine(l, lang)).length;
  const codeLines    = nonEmpty.length - commentLines;
  if (codeLines === 0) return 1; // all comments
  return round3(commentLines / codeLines);
}

// ── Naming consistency ────────────────────────────────────────────────────────

const CAMEL_RE      = /\b[a-z][a-z0-9]*(?:[A-Z][a-z0-9]+)+\b/g;
const PASCAL_RE     = /\b[A-Z][a-z0-9]+(?:[A-Z][a-z0-9]+)+\b/g;
const SNAKE_RE      = /\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g;
const SCREAMING_RE  = /\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/g;

function computeNamingConsistency(lines: string[]): number {
  if (lines.length === 0) return 0;
  const joined = lines.join('\n');

  const camel     = (joined.match(CAMEL_RE)     ?? []).length;
  const pascal    = (joined.match(PASCAL_RE)    ?? []).length;
  const snake     = (joined.match(SNAKE_RE)     ?? []).length;
  const screaming = (joined.match(SCREAMING_RE) ?? []).length;

  const total = camel + pascal + snake + screaming;
  if (total < 4) return 0.5; // not enough identifiers to judge

  const dominant = Math.max(camel, pascal, snake, screaming);
  return round3(dominant / total);
}

// ── AI-likelihood composite ───────────────────────────────────────────────────

/**
 * Weighted composite:
 *   coherenceScore    × 0.25
 *   boilerplateRatio  × 0.20
 *   commentDensity    > 0.15 → +0.15, else +0
 *   namingConsistency × 0.20
 *   linesAdded size bonus: >50 → +0.20, >20 → +0.10, else +0
 */
function computeAiLikelihood(fp: Omit<DiffFingerprint, 'aiLikelihood' | 'indicators'>): number {
  const commentBonus  = fp.commentDensity > 0.15 ? 0.15 : 0;
  const sizeBonus     = fp.linesAdded > 50 ? 0.20 : fp.linesAdded > 20 ? 0.10 : 0;

  return round3(
    fp.coherenceScore   * 0.25 +
    fp.boilerplateRatio * 0.20 +
    commentBonus                +
    fp.namingConsistency * 0.20 +
    sizeBonus,
  );
}

// ── Indicator generation ──────────────────────────────────────────────────────

function buildIndicators(fp: Omit<DiffFingerprint, 'aiLikelihood' | 'indicators'>): string[] {
  const out: string[] = [];

  if (fp.coherenceScore >= 0.80)
    out.push(`High style coherence (${pct(fp.coherenceScore)}) — consistent indentation, semicolons, and quotes`);

  if (fp.boilerplateRatio >= 0.25)
    out.push(`Elevated boilerplate ratio (${pct(fp.boilerplateRatio)}) — many import/try-catch/guard patterns`);

  if (fp.commentDensity > 0.15)
    out.push(`Above-threshold comment density (${fp.commentDensity.toFixed(2)} comments/line) — common in AI-generated code`);

  if (fp.namingConsistency >= 0.85)
    out.push(`Strong naming consistency (${pct(fp.namingConsistency)}) — single convention dominates the diff`);

  if (fp.linesAdded > 50)
    out.push(`Large insertion (${fp.linesAdded} lines added) — uncommon for manual edits`);
  else if (fp.linesAdded > 20)
    out.push(`Moderate insertion (${fp.linesAdded} lines added)`);

  return out;
}

// ── Public API ────────────────────────────────────────────────────────────────

/** Analyse a unified-diff string and return an AI-likelihood fingerprint. */
export function analyzeDiff(diffText: string): DiffFingerprint {
  const { added, removed } = parseDiff(diffText);
  const lang = detectLanguage(added);

  const partial = {
    linesAdded:        added.length,
    linesRemoved:      removed.length,
    coherenceScore:    computeCoherenceScore(added),
    boilerplateRatio:  computeBoilerplateRatio(added),
    commentDensity:    computeCommentDensity(added, lang),
    namingConsistency: computeNamingConsistency(added),
  };

  const aiLikelihood = computeAiLikelihood(partial);
  const indicators   = buildIndicators(partial);

  return { ...partial, aiLikelihood, indicators };
}

/**
 * Compare a diff's fingerprint against historical baselines from the same author.
 *
 * @param diffText            The diff to evaluate.
 * @param baselineFingerprints Historical fingerprints representing the author's normal style.
 * @returns deviation (0–1) and a list of per-metric deviation details.
 */
export function compareToCodingStyle(
  diffText:            string,
  baselineFingerprints: DiffFingerprint[],
): { deviation: number; details: string[] } {
  if (baselineFingerprints.length === 0) {
    return { deviation: 0, details: ['No baseline fingerprints provided — deviation cannot be computed'] };
  }

  const current = analyzeDiff(diffText);

  // Compute per-metric baseline averages
  const avg = averageFingerprints(baselineFingerprints);

  // Metrics to compare and their human-readable labels
  const metrics: Array<{ key: keyof typeof avg; label: string }> = [
    { key: 'coherenceScore',   label: 'coherence score' },
    { key: 'boilerplateRatio', label: 'boilerplate ratio' },
    { key: 'commentDensity',   label: 'comment density' },
    { key: 'namingConsistency',label: 'naming consistency' },
    { key: 'aiLikelihood',     label: 'AI likelihood' },
  ];

  const deviations: number[] = [];
  const details:    string[] = [];

  for (const { key, label } of metrics) {
    const baseline = avg[key];
    const actual   = current[key];
    const delta    = Math.abs(actual - baseline);
    deviations.push(delta);

    // Only surface deviations large enough to be meaningful (> 0.10)
    if (delta > 0.10) {
      const direction = actual > baseline ? 'higher' : 'lower';
      details.push(
        `${label}: ${actual.toFixed(2)} vs baseline ${baseline.toFixed(2)} ` +
        `(${direction} by ${delta.toFixed(2)})`,
      );
    }
  }

  // Size deviation: normalise lines-added difference against a 100-line scale
  const lineDelta = Math.abs(current.linesAdded - avg.linesAdded) / 100;
  const normLineDelta = Math.min(1, lineDelta);
  deviations.push(normLineDelta);
  if (normLineDelta > 0.20) {
    details.push(
      `lines added: ${current.linesAdded} vs baseline avg ${avg.linesAdded.toFixed(0)} ` +
      `(delta ${Math.abs(current.linesAdded - avg.linesAdded)} lines)`,
    );
  }

  const deviation = round3(
    deviations.reduce((a, b) => a + b, 0) / deviations.length,
  );

  if (details.length === 0) {
    details.push('All metrics are within normal range of the baseline');
  }

  return { deviation, details };
}

// ── Internal utilities ────────────────────────────────────────────────────────

type NumericFields = Pick<DiffFingerprint,
  'coherenceScore' | 'boilerplateRatio' | 'commentDensity' |
  'namingConsistency' | 'aiLikelihood' | 'linesAdded' | 'linesRemoved'>;

function averageFingerprints(fps: DiffFingerprint[]): NumericFields {
  const sum = (key: keyof NumericFields) =>
    fps.reduce((acc, fp) => acc + fp[key], 0) / fps.length;

  return {
    coherenceScore:    sum('coherenceScore'),
    boilerplateRatio:  sum('boilerplateRatio'),
    commentDensity:    sum('commentDensity'),
    namingConsistency: sum('namingConsistency'),
    aiLikelihood:      sum('aiLikelihood'),
    linesAdded:        sum('linesAdded'),
    linesRemoved:      sum('linesRemoved'),
  };
}

function round3(n: number): number {
  return Math.round(Math.min(1, Math.max(0, n)) * 1000) / 1000;
}

function pct(n: number): string {
  return (n * 100).toFixed(0) + '%';
}
