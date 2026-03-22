import * as fs from 'node:fs';
import * as path from 'node:path';
import { Command } from 'commander';
import { simpleGit } from 'simple-git';
import { SidecarWriter, AITool } from '@brela-dev/core';
import type { AttributionEntry } from '@brela-dev/core';
import { BrelaExit, logError } from '../errors.js';

// ── ANSI helpers ──────────────────────────────────────────────────────────────

const NO_COLOR = !!process.env['NO_COLOR'];

function c(code: string, text: string): string {
  if (NO_COLOR) return text;
  return `\x1b[${code}m${text}\x1b[0m`;
}

const blue   = (t: string) => c('34', t);
const orange = (t: string) => c('33', t);
const purple = (t: string) => c('35', t);
const grey   = (t: string) => c('90', t);
const green  = (t: string) => c('32', t);
const yellow = (t: string) => c('33', t);
const red    = (t: string) => c('31', t);
const bold   = (t: string) => c('1',  t);
const dim    = (t: string) => c('2',  t);

function toolColour(tool: string): (t: string) => string {
  if (tool.startsWith('COPILOT'))      return blue;
  if (tool.startsWith('CLAUDE'))       return orange;
  if (tool.startsWith('CURSOR'))       return purple;
  if (tool === 'CHATGPT_PASTE')        return grey;
  if (tool === 'CODEIUM')              return purple;
  return (t: string) => t;
}

function confidenceDot(confidence: string): string {
  if (confidence === 'high')   return green('●');
  if (confidence === 'medium') return yellow('●');
  return red('●');
}

// ── Tool labels ───────────────────────────────────────────────────────────────

const TOOL_LABELS: Record<string, string> = {
  COPILOT:           'Copilot',
  COPILOT_AGENT:     'Copilot Agent',
  COPILOT_CLI:       'Copilot CLI',
  CLAUDE_CODE:       'Claude Code',
  CLAUDE_CODE_AGENT: 'Claude Code Agent',
  CURSOR:            'Cursor',
  CURSOR_AGENT:      'Cursor Agent',
  CODEIUM:           'Windsurf/Codeium',
  CLINE:             'Cline',
  AIDER:             'Aider',
  CONTINUE:          'Continue',
  CHATGPT_PASTE:     'ChatGPT Paste',
  GENERIC_AGENT:     'AI Agent',
  UNKNOWN:           'Unknown',
};

function label(tool: string): string {
  return TOOL_LABELS[tool] ?? tool;
}

// ── Box drawing ───────────────────────────────────────────────────────────────

const BOX_WIDTH = 56; // inner content width (between borders)

function header(title: string): string {
  const inner = ` ${title} `.padEnd(BOX_WIDTH);
  return [
    `╔${'═'.repeat(BOX_WIDTH)}╗`,
    `║${inner}║`,
    `╚${'═'.repeat(BOX_WIDTH)}╝`,
  ].join('\n');
}

function box(title: string, lines: string[]): string {
  const topBar   = `  ┌─ ${title} ${'─'.repeat(Math.max(0, BOX_WIDTH - title.length - 4))}┐`;
  const bottomBar = `  └${'─'.repeat(BOX_WIDTH - 1)}┘`;
  const body = lines.map((l) => `  │  ${l.padEnd(BOX_WIDTH - 5)}│`).join('\n');
  return [topBar, body, bottomBar].join('\n');
}

// ── Git helpers ───────────────────────────────────────────────────────────────

interface ReviewInfo {
  reviewed: number;
  unreviewed: number;
}

async function getReviewInfo(
  projectRoot: string,
  filePath: string,
): Promise<ReviewInfo> {
  try {
    const git = simpleGit(projectRoot);
    // Get commits that touched this file
    const log = await git.log({ file: filePath, maxCount: 50 });
    let reviewed = 0;
    let unreviewed = 0;
    for (const commit of log.all) {
      const msg = (commit.message + ' ' + (commit.body ?? '')).toLowerCase();
      if (
        msg.includes('reviewed-by') ||
        msg.includes('approved-by') ||
        msg.includes('co-authored') ||
        msg.includes('reviewed') ||
        msg.includes('approved')
      ) {
        reviewed++;
      } else {
        unreviewed++;
      }
    }
    return { reviewed, unreviewed };
  } catch {
    return { reviewed: 0, unreviewed: 0 };
  }
}

// ── Project root resolution ───────────────────────────────────────────────────

async function findProjectRoot(startDir: string): Promise<string> {
  try {
    const git = simpleGit(startDir);
    const root = await git.revparse(['--show-toplevel']);
    return root.trim();
  } catch {
    // Walk up looking for .brela/
    let dir = startDir;
    for (let i = 0; i < 10; i++) {
      if (fs.existsSync(path.join(dir, '.brela'))) return dir;
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    return startDir;
  }
}

// ── Date helpers ──────────────────────────────────────────────────────────────

function toDateStr(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function addDays(date: Date, n: number): Date {
  const d = new Date(date);
  d.setUTCDate(d.getUTCDate() + n);
  return d;
}

// ── File matching ─────────────────────────────────────────────────────────────

/**
 * Returns true if the stored entry.file matches the target path.
 * Handles: exact match, relative-from-root, and basename match.
 */
function fileMatches(entryFile: string, targetRel: string, targetBase: string): boolean {
  const norm = entryFile.replace(/\\/g, '/');
  const targetNorm = targetRel.replace(/\\/g, '/');
  if (norm === targetNorm) return true;
  // stored as absolute — check suffix
  if (norm.endsWith('/' + targetNorm)) return true;
  // basename match
  if (path.basename(norm) === targetBase) return true;
  return false;
}

// ── JSON output ───────────────────────────────────────────────────────────────

interface ExplainJson {
  file: string;
  analysedDays: number;
  totalEvents: number;
  totalCharsInserted: number;
  tools: Record<string, number>;
  confidence: Record<string, number>;
  attributedLineRanges: Array<[number, number]>;
  timeline: Array<{
    timestamp: string;
    tool: string;
    linesStart: number;
    linesEnd: number;
    confidence: string;
    detectionMethod: string;
    charsInserted: number;
  }>;
  risk: {
    unreviewedAISections: number;
    reviewedAISections: number;
    hasTestCoverageOnAILines: boolean;
  };
}

// ── Main command logic ────────────────────────────────────────────────────────

async function runExplain(
  filePath: string,
  opts: { days: string; json: boolean; since?: string; repo?: string },
): Promise<void> {
  // 1. Resolve project root
  const cwd = process.cwd();
  const projectRoot = opts.repo
    ? path.resolve(opts.repo)
    : await findProjectRoot(cwd);

  // 2. Resolve file to relative path from project root
  const absFile = path.isAbsolute(filePath)
    ? filePath
    : path.resolve(cwd, filePath);
  const relFile = path.relative(projectRoot, absFile);
  const baseFile = path.basename(relFile);

  // 3. Warn if file doesn't exist on disk (still show historical data)
  const fileExistsOnDisk = fs.existsSync(absFile);
  if (!fileExistsOnDisk && !opts.json) {
    process.stdout.write(
      yellow('⚠') +
      `  ${relFile} does not exist on disk — showing historical attribution data only.\n\n`,
    );
  }

  // 4. Check .brela/ exists
  const brelaDir = path.join(projectRoot, '.brela');
  if (!fs.existsSync(brelaDir)) {
    process.stdout.write(
      [
        red('✗') + '  No .brela/ directory found in ' + projectRoot,
        '',
        '  Run ' + bold('brela init') + ' to set up attribution tracking in this project.',
      ].join('\n') + '\n',
    );
    return;
  }

  // 5. Compute date range
  const toDate = new Date();
  let fromDate: Date;
  let analysedDays: number;

  if (opts.since) {
    fromDate = new Date(opts.since);
    analysedDays = Math.ceil((toDate.getTime() - fromDate.getTime()) / 86_400_000);
  } else {
    analysedDays = Math.max(1, parseInt(opts.days, 10) || 90);
    fromDate = addDays(toDate, -analysedDays);
  }

  // 6. Read and filter session entries
  const writer = new SidecarWriter(projectRoot);
  const allEntries = writer.readRange(toDateStr(fromDate), toDateStr(toDate));
  const entries = allEntries.filter((e) =>
    fileMatches(e.file, relFile, baseFile),
  );

  // 7. Sort ascending for timeline
  entries.sort(
    (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
  );

  // 8. No data case
  if (entries.length === 0) {
    if (opts.json) {
      process.stdout.write(JSON.stringify({
        file: relFile,
        analysedDays,
        totalEvents: 0,
        totalCharsInserted: 0,
        tools: {},
        confidence: {},
        attributedLineRanges: [],
        timeline: [],
        risk: { unreviewedAISections: 0, reviewedAISections: 0, hasTestCoverageOnAILines: false },
      }, null, 2) + '\n');
    } else {
      process.stdout.write(
        `No attribution data found for ${bold(relFile)} in the last ${analysedDays} days.\n` +
        `Either this file had no AI-assisted edits, or brela was not active.\n`,
      );
    }
    return;
  }

  // 9. Aggregate stats
  const totalChars = entries.reduce((s, e) => s + e.charsInserted, 0);
  const toolCounts: Record<string, number> = {};
  const confCounts: Record<string, number> = {};

  for (const e of entries) {
    toolCounts[e.tool] = (toolCounts[e.tool] ?? 0) + 1;
    confCounts[e.confidence] = (confCounts[e.confidence] ?? 0) + 1;
  }

  // Deduplicate + collect line ranges
  const ranges: Array<[number, number]> = entries
    .filter((e) => e.linesStart > 0 || e.linesEnd > 0)
    .map((e) => [e.linesStart, e.linesEnd] as [number, number]);

  // 10. Risk signals
  const reviewInfo = await getReviewInfo(projectRoot, relFile);
  const aiSections = entries.length;
  const reviewedSections = Math.min(reviewInfo.reviewed, aiSections);
  const unreviewedSections = Math.max(0, aiSections - reviewedSections);

  // Test coverage: simple heuristic — check if a test file exists for this file
  const stem = path.basename(relFile, path.extname(relFile));
  const possibleTestFiles = [
    path.join(projectRoot, 'src', '__tests__', `${stem}.test.ts`),
    path.join(projectRoot, 'src', `${stem}.test.ts`),
    path.join(projectRoot, 'tests', `${stem}.test.ts`),
    path.join(path.dirname(absFile), '__tests__', `${stem}.test.ts`),
    path.join(path.dirname(absFile), `${stem}.test.ts`),
    path.join(path.dirname(absFile), `${stem}.spec.ts`),
  ];
  const hasTests = possibleTestFiles.some((f) => fs.existsSync(f));

  // 11. Output
  if (opts.json) {
    const out: ExplainJson = {
      file: relFile,
      analysedDays,
      totalEvents: entries.length,
      totalCharsInserted: totalChars,
      tools: toolCounts,
      confidence: confCounts,
      attributedLineRanges: ranges,
      timeline: entries.map((e) => ({
        timestamp: e.timestamp,
        tool: e.tool,
        linesStart: e.linesStart,
        linesEnd: e.linesEnd,
        confidence: e.confidence,
        detectionMethod: e.detectionMethod,
        charsInserted: e.charsInserted,
      })),
      risk: {
        unreviewedAISections: unreviewedSections,
        reviewedAISections: reviewedSections,
        hasTestCoverageOnAILines: hasTests,
      },
    };
    process.stdout.write(JSON.stringify(out, null, 2) + '\n');
    return;
  }

  // ── Pretty terminal output ────────────────────────────────────────────────

  // Sessions = distinct dates touched
  const sessionDates = new Set(entries.map((e) => e.timestamp.slice(0, 10)));

  // Header
  process.stdout.write('\n' + header(`brela explain — ${relFile}`) + '\n\n');

  // Meta line
  process.stdout.write(
    `  ${dim('File:')}        ${relFile}\n` +
    `  ${dim('Analysed:')}    last ${analysedDays} days (${sessionDates.size} session${sessionDates.size !== 1 ? 's' : ''} found)\n\n`,
  );

  // ── Attribution Summary box ───────────────────────────────────────────────
  const toolSummary = Object.entries(toolCounts)
    .sort((a, b) => b[1] - a[1])
    .map(([tool, n]) => toolColour(tool)(`${label(tool)} (${n})`))
    .join(', ');

  const confSummary = Object.entries(confCounts)
    .map(([c, n]) => `${c[0]!.toUpperCase() + c.slice(1)} (${n})`)
    .join(', ');

  const rangeStr = ranges.length > 0
    ? ranges.slice(0, 5).map(([s, e]) => `L${s}-${e}`).join(', ') +
      (ranges.length > 5 ? ` +${ranges.length - 5} more` : '')
    : 'n/a';

  const summaryLines = [
    `AI-assisted insertions:  ${bold(String(entries.length))} events`,
    `Total AI chars inserted: ${bold(totalChars.toLocaleString())}`,
    `Tools detected:          ${toolSummary}`,
    `Confidence:              ${confSummary}`,
    `Lines attributed:        ${rangeStr}`,
  ];
  process.stdout.write(box('Attribution Summary', summaryLines) + '\n\n');

  // ── Timeline box ─────────────────────────────────────────────────────────
  const timelineLines = entries.slice(0, 10).map((e) => {
    const date = e.timestamp.slice(0, 10);
    const time = e.timestamp.slice(11, 16);
    const toolStr = toolColour(e.tool)(label(e.tool).padEnd(18));
    const lineStr = e.linesEnd > 0 ? `L${e.linesStart}-${e.linesEnd}` : 'n/a';
    const conf = e.confidence === 'high' ? 'HIGH' : e.confidence === 'medium' ? 'MED ' : 'LOW ';
    return `${dim(date + ' ' + time)}  ${confidenceDot(e.confidence)} ${toolStr}  ${lineStr.padEnd(10)}  ${conf}`;
  });

  if (entries.length > 10) {
    timelineLines.push(dim(`  … and ${entries.length - 10} more events`));
  }

  process.stdout.write(box('Timeline', timelineLines) + '\n\n');

  // ── Risk Assessment box ───────────────────────────────────────────────────
  const riskLines: string[] = [];

  if (unreviewedSections > 0) {
    riskLines.push(
      yellow('⚠') + `  ${unreviewedSections} AI section${unreviewedSections !== 1 ? 's' : ''} have never been in a reviewed commit`,
    );
  }
  if (reviewedSections > 0) {
    riskLines.push(
      green('✓') + `  ${reviewedSections} AI section${reviewedSections !== 1 ? 's' : ''} were committed with review signals`,
    );
  }
  if (!hasTests) {
    riskLines.push(
      red('✗') + `  No test file found for ${baseFile}`,
    );
  } else {
    riskLines.push(
      green('✓') + `  Test file found for ${baseFile}`,
    );
  }
  if (confCounts['low'] ?? 0 > 0) {
    riskLines.push(
      yellow('⚠') + `  ${confCounts['low']} low-confidence attribution${(confCounts['low'] ?? 0) !== 1 ? 's' : ''} — review manually`,
    );
  }

  if (riskLines.length === 0) {
    riskLines.push(green('✓') + '  No risk signals detected');
  }

  process.stdout.write(box('Risk Assessment', riskLines) + '\n\n');

  // Tip
  process.stdout.write(
    dim(`  Tip: Run \`brela explain ${relFile} --json\` for machine-readable output.\n`) + '\n',
  );
}

// ── Commander registration ────────────────────────────────────────────────────

export function explainCommand(): Command {
  return new Command('explain')
    .description('Show AI attribution history for a specific file')
    .argument('<file>', 'file path to explain (relative or absolute)')
    .option('--days <n>', 'days of history to analyse', '90')
    .option('--json', 'output as JSON')
    .option('--since <date>', 'analyse from date (YYYY-MM-DD)')
    .option('--repo <path>', 'project root path')
    .action(async (file: string, opts: { days: string; json: boolean; since?: string; repo?: string }) => {
      try {
        await runExplain(file, opts);
      } catch (err) {
        logError(process.cwd(), err);
        if (!opts.json) {
          process.stdout.write(red('✗') + `  Unexpected error: ${String(err)}\n`);
        }
      }
    });
}
