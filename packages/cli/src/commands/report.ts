import * as fs from 'node:fs';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import { Command } from 'commander';
import { simpleGit } from 'simple-git';
import { DetectionMethod, AITool } from '@brela-dev/core';
import type { AttributionEntry } from '@brela-dev/core';
import { BrelaExit, logError } from '../errors.js';

const _require = createRequire(import.meta.url);

// ── Types ─────────────────────────────────────────────────────────────────────

interface CommitRecord {
  commitHash: string;
  timestamp: string;
  files: Array<{ path: string; tool: string; confidence: string; detectionMethod: string }>;
  sessionId: string;
}

interface GitCommitInfo {
  hash: string;
  shortHash: string;
  authorEmail: string;
  authorName: string;
  date: string;           // YYYY-MM-DD
  subject: string;
  hasReviewer: boolean;
  linesAdded: number;
  fileLines: Map<string, number>;   // file → lines added in this commit
  files: string[];
}

interface TrailerEntry {
  commitHash: string;
  date: string;
  tool: AITool;
  files: string[];
  linesAdded: number;
}

export interface ReportMetrics {
  generatedAt: string;
  projectRoot: string;
  daysAnalysed: number;
  dateFrom: string;
  dateTo: string;
  insufficientData: boolean;
  aiPercentage: number;
  totalAiLines: number;
  totalHumanLines: number;
  perToolBreakdown: Record<string, number>;
  perFileHeatmap: Array<{
    file: string; aiLines: number; totalLines: number; aiPct: number; topTool: string;
  }>;
  perDayTrend: Array<{ date: string; humanLines: number; aiLines: number }>;
  confidenceDistribution: { high: number; medium: number; low: number };
  unreviewedAiCommits: Array<{
    hash: string; shortHash: string; date: string;
    message: string; author: string; aiPct: number; tools: string[];
  }>;
  backfillCount: number;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function toDateStr(d: Date): string { return d.toISOString().slice(0, 10); }

const TOOL_LABELS: Record<string, string> = {
  COPILOT: 'Copilot', COPILOT_AGENT: 'Copilot Agent', COPILOT_CLI: 'Copilot CLI',
  CLAUDE_CODE: 'Claude Code', CLAUDE_CODE_AGENT: 'Claude Code Agent',
  CURSOR: 'Cursor', CURSOR_AGENT: 'Cursor Agent',
  CODEIUM: 'Codeium', CLINE: 'Cline', AIDER: 'Aider', CONTINUE: 'Continue',
  CHATGPT_PASTE: 'ChatGPT Paste', GENERIC_AGENT: 'AI Agent', UNKNOWN: 'Unknown',
};
function toolLabel(t: string): string { return TOOL_LABELS[t] ?? t; }

const TRAILER_MAP: Record<string, AITool> = {
  claude: AITool.CLAUDE_CODE, copilot: AITool.COPILOT,
  cursor: AITool.CURSOR, codeium: AITool.CODEIUM,
};
function toolFromCoAuthor(name: string): AITool | null {
  const lc = name.toLowerCase();
  for (const [k, v] of Object.entries(TRAILER_MAP)) { if (lc.includes(k)) return v; }
  return null;
}

// ── Data readers ──────────────────────────────────────────────────────────────

function readCommitsJsonl(brelaDir: string): CommitRecord[] {
  const f = path.join(brelaDir, 'commits.jsonl');
  if (!fs.existsSync(f)) return [];
  return fs.readFileSync(f, 'utf8').split('\n').filter(l => l.trim())
    .flatMap(l => { try { return [JSON.parse(l) as CommitRecord]; } catch { return []; } });
}

function readSessionEntries(brelaDir: string, fromDate: Date): AttributionEntry[] {
  const dir = path.join(brelaDir, 'sessions');
  if (!fs.existsSync(dir)) return [];
  const cutoffMs = fromDate.getTime();
  const results: AttributionEntry[] = [];
  for (const file of fs.readdirSync(dir)) {
    if (!file.endsWith('.json')) continue;
    const fileMs = new Date(file.replace('.json', '')).getTime();
    if (isNaN(fileMs) || fileMs < cutoffMs) continue;
    for (const line of fs.readFileSync(path.join(dir, file), 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try { results.push(JSON.parse(line) as AttributionEntry); } catch { /* skip */ }
    }
  }
  return results;
}

// ── Git data ──────────────────────────────────────────────────────────────────

interface GitData {
  commits: GitCommitInfo[];
  trailerEntries: TrailerEntry[];
  perDayAdded: Map<string, number>;
  perFileTotal: Map<string, number>;
}

async function readGitData(projectRoot: string, fromDate: Date): Promise<GitData> {
  const empty: GitData = {
    commits: [], trailerEntries: [],
    perDayAdded: new Map(), perFileTotal: new Map(),
  };
  if (!fs.existsSync(path.join(projectRoot, '.git'))) return empty;

  try {
    const git = simpleGit(projectRoot);
    const since = toDateStr(fromDate);

    // Single pass: COMMIT header lines interleaved with numstat lines
    const rawStat = await git.raw([
      'log', `--since=${since}`,
      '--format=PCOMMIT|%H|%h|%ae|%an|%ai|%s',
      '--numstat',
    ]);

    // Separate pass: full commit bodies for trailer + reviewer detection
    const rawBodies = await git.raw([
      'log', `--since=${since}`,
      '--format=PSTART|%H%n%B%nPEND',
    ]);

    // ── Parse numstat log ────────────────────────────────────────────────────
    const commits: GitCommitInfo[] = [];
    const perDayAdded = new Map<string, number>();
    const perFileTotal = new Map<string, number>();
    let cur: GitCommitInfo | null = null;

    for (const line of rawStat.split('\n')) {
      if (line.startsWith('PCOMMIT|')) {
        if (cur) commits.push(cur);
        const parts = line.split('|');
        const date = (parts[5] ?? '').slice(0, 10);
        cur = {
          hash: parts[1] ?? '', shortHash: parts[2] ?? '',
          authorEmail: parts[3] ?? '', authorName: parts[4] ?? '',
          date, subject: parts.slice(6).join('|'),
          hasReviewer: false, linesAdded: 0,
          fileLines: new Map(), files: [],
        };
      } else if (cur) {
        const cols = line.split('\t');
        if (cols.length === 3 && cols[0] !== undefined && cols[0] !== '-') {
          const added = parseInt(cols[0], 10);
          const file = cols[2] ?? '';
          if (!isNaN(added) && added > 0 && file) {
            cur.linesAdded += added;
            cur.files.push(file);
            cur.fileLines.set(file, (cur.fileLines.get(file) ?? 0) + added);
            perDayAdded.set(cur.date, (perDayAdded.get(cur.date) ?? 0) + added);
            perFileTotal.set(file, (perFileTotal.get(file) ?? 0) + added);
          }
        }
      }
    }
    if (cur) commits.push(cur);

    // ── Parse bodies: reviewer detection + co-author trailers ───────────────
    const bodyMap = new Map<string, string>();
    let bHash = '';
    const bLines: string[] = [];

    for (const line of rawBodies.split('\n')) {
      if (line.startsWith('PSTART|')) {
        if (bHash) bodyMap.set(bHash, bLines.join('\n'));
        bHash = line.slice('PSTART|'.length);
        bLines.length = 0;
      } else if (line === 'PEND') {
        if (bHash) bodyMap.set(bHash, bLines.join('\n'));
        bHash = '';
        bLines.length = 0;
      } else {
        bLines.push(line);
      }
    }
    if (bHash) bodyMap.set(bHash, bLines.join('\n'));

    const trailerEntries: TrailerEntry[] = [];

    for (const commit of commits) {
      const body = bodyMap.get(commit.hash) ?? '';
      const lc = body.toLowerCase();
      commit.hasReviewer = lc.includes('reviewed-by:') || lc.includes('approved-by:');

      const coRe = /co-authored-by:\s*([^<\n]+)/gi;
      let m: RegExpExecArray | null;
      while ((m = coRe.exec(body)) !== null) {
        const tool = toolFromCoAuthor(m[1] ?? '');
        if (tool !== null) {
          trailerEntries.push({
            commitHash: commit.hash, date: commit.date,
            tool, files: commit.files, linesAdded: commit.linesAdded,
          });
        }
      }
    }

    return { commits, trailerEntries, perDayAdded, perFileTotal };
  } catch {
    return empty;
  }
}

// ── Metrics ───────────────────────────────────────────────────────────────────

export async function computeMetrics(projectRoot: string, days: number): Promise<ReportMetrics> {
  const now = new Date();
  const fromDate = new Date(now);
  fromDate.setDate(fromDate.getDate() - days);
  fromDate.setHours(0, 0, 0, 0);

  const brelaDir = path.join(projectRoot, '.brela');
  const sessionEntries = readSessionEntries(brelaDir, fromDate);

  // Oldest entry determines data freshness
  const oldest = sessionEntries.reduce<Date | null>((min, e) => {
    const d = new Date(e.timestamp);
    return !min || d < min ? d : min;
  }, null);
  const ageMs = oldest ? now.getTime() - oldest.getTime() : 0;
  const insufficientData = sessionEntries.length === 0 || ageMs < 3 * 86_400_000;

  const brelaCommits = readCommitsJsonl(brelaDir);
  const gitData = await readGitData(projectRoot, fromDate);

  const backfillEntries: AttributionEntry[] = [];
  const allEntries = [...sessionEntries];

  // ── Aggregate per-file and per-tool ───────────────────────────────────────
  const fileMap = new Map<string, { aiLines: number; tools: Map<string, number> }>();
  const toolTotals = new Map<string, number>();
  const confDist = { high: 0, medium: 0, low: 0 };
  const aiByDay = new Map<string, number>();

  for (const e of allEntries) {
    const lines = Math.max(0, e.linesEnd - e.linesStart);
    const label = toolLabel(e.tool);
    const date = toDateStr(new Date(e.timestamp));

    // File accumulation
    if (!fileMap.has(e.file)) fileMap.set(e.file, { aiLines: 0, tools: new Map() });
    const fstat = fileMap.get(e.file)!;
    fstat.aiLines += lines;
    fstat.tools.set(label, (fstat.tools.get(label) ?? 0) + lines);

    // Global tool totals
    toolTotals.set(label, (toolTotals.get(label) ?? 0) + lines);

    // Confidence
    if (e.confidence === 'high') confDist.high++;
    else if (e.confidence === 'medium') confDist.medium++;
    else confDist.low++;

    // Day buckets
    aiByDay.set(date, (aiByDay.get(date) ?? 0) + lines);
  }

  const totalAiLines = [...toolTotals.values()].reduce((a, b) => a + b, 0);
  const totalGitLines = [...gitData.perDayAdded.values()].reduce((a, b) => a + b, 0);
  const totalLines = Math.max(totalGitLines, totalAiLines);
  const totalHumanLines = Math.max(0, totalLines - totalAiLines);
  const aiPercentage = totalLines > 0 ? (totalAiLines / totalLines) * 100 : 0;

  // ── Per-tool breakdown (% of AI lines) ────────────────────────────────────
  const perToolBreakdown: Record<string, number> = {};
  for (const [t, n] of toolTotals) {
    perToolBreakdown[t] = totalAiLines > 0 ? (n / totalAiLines) * 100 : 0;
  }

  // ── Per-file heatmap (top 20 by AI%) ──────────────────────────────────────
  const perFileHeatmap = [...fileMap.entries()].map(([file, stat]) => {
    const totalLines = Math.max(gitData.perFileTotal.get(file) ?? 0, stat.aiLines);
    const topTool = [...stat.tools.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'Unknown';
    return {
      file, aiLines: stat.aiLines, totalLines,
      aiPct: totalLines > 0 ? (stat.aiLines / totalLines) * 100 : 100,
      topTool,
    };
  }).sort((a, b) => b.aiPct - a.aiPct).slice(0, 20);

  // ── Per-day trend ──────────────────────────────────────────────────────────
  const perDayTrend = Array.from({ length: days }, (_, i) => {
    const d = new Date(now);
    d.setDate(d.getDate() - (days - 1 - i));
    const date = toDateStr(d);
    const aiLines = aiByDay.get(date) ?? 0;
    const humanLines = Math.max(0, (gitData.perDayAdded.get(date) ?? 0) - aiLines);
    return { date, humanLines, aiLines };
  });

  // ── Unreviewed AI commits ──────────────────────────────────────────────────
  const unreviewedAiCommits: ReportMetrics['unreviewedAiCommits'] = [];
  for (const commit of gitData.commits) {
    if (commit.hasReviewer) continue;
    const record = brelaCommits.find(r => r.commitHash === commit.hash);
    if (!record) continue;

    const aiFileSet = new Set(record.files.map(f => f.path));
    let aiLines = 0, total = 0;
    for (const [file, n] of commit.fileLines) {
      total += n;
      if (aiFileSet.has(file)) aiLines += n;
    }
    const aiPct = total > 0 ? (aiLines / total) * 100 : 0;
    if (aiPct < 60) continue;

    unreviewedAiCommits.push({
      hash: commit.hash, shortHash: commit.shortHash,
      date: commit.date, message: commit.subject,
      author: commit.authorName || commit.authorEmail,
      aiPct,
      tools: [...new Set(record.files.map(f => toolLabel(f.tool)))],
    });
  }

  return {
    generatedAt: now.toISOString(),
    projectRoot, daysAnalysed: days,
    dateFrom: toDateStr(fromDate), dateTo: toDateStr(now),
    insufficientData, aiPercentage, totalAiLines, totalHumanLines,
    perToolBreakdown, perFileHeatmap, perDayTrend,
    confidenceDistribution: confDist,
    unreviewedAiCommits,
    backfillCount: backfillEntries.length,
  };
}

// ── Chart.js loader ───────────────────────────────────────────────────────────

function loadChartJs(): string {
  const main = _require.resolve('chart.js');
  const umd = path.join(path.dirname(main), 'chart.umd.js');
  if (fs.existsSync(umd)) return fs.readFileSync(umd, 'utf8');
  throw new Error(`chart.umd.js not found near ${main} — run npm install`);
}

// ── HTML generation ───────────────────────────────────────────────────────────

function pct(n: number): string { return n.toFixed(1) + '%'; }

function pctPill(p: number): string {
  let bg: string, fg: string;
  if (p <= 30)       { bg = '#DCFCE7'; fg = '#15803D'; }
  else if (p <= 60)  { bg = '#FEF9C3'; fg = '#A16207'; }
  else               { bg = '#FEE2E2'; fg = '#B91C1C'; }
  return `<span style="display:inline-block;padding:2px 10px;border-radius:12px;font-size:11px;font-weight:600;background:${bg};color:${fg}">${p.toFixed(1)}%</span>`;
}

function generateHtml(m: ReportMetrics, chartJs: string): string {
  const metricsJson = JSON.stringify(m, null, 0);
  const repo        = escHtml(path.basename(m.projectRoot));
  const dateRange   = `${m.dateFrom} – ${m.dateTo}`;
  const generatedAt = new Date(m.generatedAt).toLocaleString();

  const topTool = Object.entries(m.perToolBreakdown)
    .sort((a, b) => b[1] - a[1])[0]?.[0] ?? '—';

  // ── Warning banner ────────────────────────────────────────────────────────
  const warningBanner = m.insufficientData ? `
  <div id="warningBanner" style="display:flex;align-items:center;justify-content:space-between;
       background:#FFFBEB;border:1px solid #F59E0B;border-radius:8px;
       padding:12px 16px;margin-bottom:24px;font-size:13px;color:#92400E">
    <span>⚠️&nbsp; Insufficient data — report covers less than 3 days. Results may not be representative.</span>
    <button id="dismissWarning" style="background:none;border:none;cursor:pointer;
            font-size:16px;color:#92400E;padding:0 4px;line-height:1">✕</button>
  </div>` : '';

  // ── File heatmap rows ─────────────────────────────────────────────────────
  const heatmapRows = m.perFileHeatmap.map((f, i) => {
    const rowBg = i % 2 === 1 ? '#F9FAFB' : '#ffffff';
    return `<tr data-pct="${f.aiPct.toFixed(2)}" data-file="${escHtml(f.file)}" data-tool="${escHtml(f.topTool)}" data-ai="${f.aiLines}" data-total="${f.totalLines}"
         style="background:${rowBg};height:44px;border-bottom:1px solid #F3F4F6"
         onmouseover="this.style.background='#F0F9FF'" onmouseout="this.style.background='${rowBg}'">
      <td style="padding:0 16px;font-family:'SF Mono',Menlo,monospace;font-size:12px;color:#111827;max-width:320px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escHtml(f.file)}</td>
      <td style="padding:0 16px;font-size:13px;color:#6B7280">${escHtml(f.topTool)}</td>
      <td style="padding:0 16px;font-size:13px;color:#111827;text-align:right">${f.aiLines.toLocaleString()}</td>
      <td style="padding:0 16px;font-size:13px;color:#111827;text-align:right">${f.totalLines.toLocaleString()}</td>
      <td style="padding:0 16px">${pctPill(f.aiPct)}</td>
    </tr>`;
  }).join('\n');

  // ── Flagged commit cards ──────────────────────────────────────────────────
  const flaggedCards = m.unreviewedAiCommits.map(c => `
  <div style="background:#fff;border:1px solid #E5E7EB;border-left:4px solid #EF4444;
              border-radius:8px;padding:16px 20px;margin-bottom:8px">
    <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:12px">
      <div style="min-width:0;overflow:hidden">
        <span style="font-family:'SF Mono',Menlo,monospace;font-size:12px;color:#6B7280">${escHtml(c.shortHash)}</span>
        <span style="font-size:13px;font-weight:500;color:#111827;margin-left:10px">${escHtml(c.message)}</span>
      </div>
      <span style="flex-shrink:0;background:#FEE2E2;color:#B91C1C;padding:2px 10px;
                  border-radius:12px;font-size:11px;font-weight:600;white-space:nowrap">AI: ${pct(c.aiPct)}</span>
    </div>
    <div style="margin-top:6px;font-size:12px;color:#6B7280">
      ${escHtml(c.author)} &nbsp;·&nbsp; ${escHtml(c.date)} &nbsp;·&nbsp; ${c.tools.map(escHtml).join(', ')}
    </div>
  </div>`).join('\n');

  const backfillNote = '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Brela Report — ${repo} — ${m.dateTo}</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
     background:#F9FAFB;color:#111827;line-height:1.5;font-size:14px}
th.sorted-asc::after{content:' ↑'}
th.sorted-desc::after{content:' ↓'}
</style>
</head>
<body>

<!-- ── Nav ── -->
<nav style="background:#fff;border-bottom:1px solid #E5E7EB;padding:0 32px;height:56px;
            display:flex;align-items:center;justify-content:space-between;
            position:sticky;top:0;z-index:10">
  <div style="display:flex;align-items:center;gap:10px">
    <span style="font-size:18px">👻</span>
    <span style="font-weight:600;font-size:15px;color:#111827">Brela Report</span>
  </div>
  <div style="font-size:13px;color:#6B7280">${repo} &nbsp;·&nbsp; ${dateRange} &nbsp;·&nbsp; Generated ${generatedAt}</div>
</nav>

<main style="max-width:1200px;margin:0 auto;padding:32px 24px">

  ${warningBanner}

  <!-- ── Stats grid ── -->
  <div style="display:grid;grid-template-columns:repeat(5,1fr);gap:12px;margin-bottom:28px">

    <div style="background:#fff;border:1px solid #E5E7EB;border-radius:8px;padding:20px 24px">
      <div style="font-size:11px;font-weight:600;color:#6B7280;letter-spacing:.06em;text-transform:uppercase;margin-bottom:8px">OVERALL AI%</div>
      <div style="font-size:32px;font-weight:700;color:#1F8EFA">${pct(m.aiPercentage)}</div>
      <div style="font-size:12px;color:#6B7280;margin-top:4px">${m.daysAnalysed} days analysed</div>
    </div>

    <div style="background:#fff;border:1px solid #E5E7EB;border-radius:8px;padding:20px 24px">
      <div style="font-size:11px;font-weight:600;color:#6B7280;letter-spacing:.06em;text-transform:uppercase;margin-bottom:8px">AI LINES</div>
      <div style="font-size:32px;font-weight:700;color:#111827">${m.totalAiLines.toLocaleString()}</div>
      <div style="font-size:12px;color:#6B7280;margin-top:4px">lines attributed to AI</div>
    </div>

    <div style="background:#fff;border:1px solid #E5E7EB;border-radius:8px;padding:20px 24px">
      <div style="font-size:11px;font-weight:600;color:#6B7280;letter-spacing:.06em;text-transform:uppercase;margin-bottom:8px">HUMAN LINES</div>
      <div style="font-size:32px;font-weight:700;color:#111827">${m.totalHumanLines.toLocaleString()}</div>
      <div style="font-size:12px;color:#6B7280;margin-top:4px">lines written by humans</div>
    </div>

    <div style="background:#fff;border:1px solid #E5E7EB;border-radius:8px;padding:20px 24px">
      <div style="font-size:11px;font-weight:600;color:#6B7280;letter-spacing:.06em;text-transform:uppercase;margin-bottom:8px">TOP TOOL</div>
      <div style="font-size:22px;font-weight:700;color:#111827;margin-top:6px">${escHtml(topTool)}</div>
      <div style="font-size:12px;color:#6B7280;margin-top:4px">most active AI tool</div>
    </div>

    <div style="background:#fff;border:1px solid ${m.unreviewedAiCommits.length > 0 ? '#FCA5A5' : '#E5E7EB'};border-radius:8px;padding:20px 24px">
      <div style="font-size:11px;font-weight:600;color:#6B7280;letter-spacing:.06em;text-transform:uppercase;margin-bottom:8px">FLAGGED COMMITS</div>
      <div style="font-size:32px;font-weight:700;color:${m.unreviewedAiCommits.length > 0 ? '#EF4444' : '#111827'}">${m.unreviewedAiCommits.length}</div>
      <div style="font-size:12px;color:#6B7280;margin-top:4px">AI &gt;60%, unreviewed</div>
    </div>

  </div>

  <!-- ── Charts row ── -->
  <div style="display:flex;gap:16px;margin-bottom:28px;align-items:flex-start">

    <div style="flex:0 0 60%;background:#fff;border:1px solid #E5E7EB;border-radius:8px;padding:20px 24px">
      <div style="font-size:13px;font-weight:600;color:#111827;margin-bottom:16px">Daily Trend</div>
      <canvas id="trendChart"></canvas>
    </div>

    <div style="flex:0 0 calc(40% - 16px);background:#fff;border:1px solid #E5E7EB;border-radius:8px;padding:20px 24px">
      <div style="font-size:13px;font-weight:600;color:#111827;margin-bottom:16px">Tool Breakdown</div>
      <canvas id="toolChart"></canvas>
    </div>

  </div>

  <!-- ── File heatmap ── -->
  <div style="background:#fff;border:1px solid #E5E7EB;border-radius:8px;margin-bottom:28px;overflow:hidden">
    <div style="padding:16px 20px;border-bottom:1px solid #E5E7EB;display:flex;align-items:center;justify-content:space-between">
      <span style="font-size:13px;font-weight:600;color:#111827">File Heatmap</span>
      <span style="font-size:12px;color:#6B7280">top ${m.perFileHeatmap.length} files by AI%</span>
    </div>
    <div style="overflow-x:auto">
      <table id="heatmapTable" style="width:100%;border-collapse:collapse">
        <thead>
          <tr style="background:#F9FAFB">
            <th data-col="file"  style="padding:10px 16px;text-align:left;font-size:11px;font-weight:600;color:#6B7280;text-transform:uppercase;letter-spacing:.06em;cursor:pointer;white-space:nowrap;border-bottom:1px solid #E5E7EB">File</th>
            <th data-col="tool"  style="padding:10px 16px;text-align:left;font-size:11px;font-weight:600;color:#6B7280;text-transform:uppercase;letter-spacing:.06em;cursor:pointer;white-space:nowrap;border-bottom:1px solid #E5E7EB">Top Tool</th>
            <th data-col="ai"    style="padding:10px 16px;text-align:right;font-size:11px;font-weight:600;color:#6B7280;text-transform:uppercase;letter-spacing:.06em;cursor:pointer;white-space:nowrap;border-bottom:1px solid #E5E7EB">AI Lines</th>
            <th data-col="total" style="padding:10px 16px;text-align:right;font-size:11px;font-weight:600;color:#6B7280;text-transform:uppercase;letter-spacing:.06em;cursor:pointer;white-space:nowrap;border-bottom:1px solid #E5E7EB">Total Lines</th>
            <th data-col="pct"   style="padding:10px 16px;text-align:left;font-size:11px;font-weight:600;color:#6B7280;text-transform:uppercase;letter-spacing:.06em;cursor:pointer;white-space:nowrap;border-bottom:1px solid #E5E7EB">AI%</th>
          </tr>
        </thead>
        <tbody>${heatmapRows}</tbody>
      </table>
    </div>
  </div>

  <!-- ── Flagged commits ── -->
  <div style="margin-bottom:28px">
    <div style="font-size:13px;font-weight:600;color:#111827;margin-bottom:12px">
      Flagged Commits
      <span style="font-size:12px;font-weight:400;color:#6B7280;margin-left:6px">AI &gt; 60%, unreviewed</span>
    </div>
    ${m.unreviewedAiCommits.length === 0
      ? '<p style="font-size:13px;color:#6B7280">No flagged commits in this period.</p>'
      : flaggedCards}
  </div>

  ${backfillNote}

  <!-- ── Export button ── -->
  <div style="display:flex;justify-content:flex-end;margin-top:8px">
    <button id="exportBtn" style="display:inline-flex;align-items:center;gap:6px;
            padding:8px 16px;border-radius:6px;border:1px solid #E5E7EB;
            background:#fff;color:#374151;font-size:13px;font-weight:500;
            cursor:pointer">↓ Export JSON</button>
  </div>

  <footer style="margin-top:40px;padding-top:16px;border-top:1px solid #E5E7EB;
                 font-size:12px;color:#9CA3AF;text-align:center">
    Brela — Silent AI code attribution — data is local, no network calls were made
  </footer>

</main>

<script>
${chartJs}
</script>
<script>
window.addEventListener('load', function() {
  var DATA = ${metricsJson};

  // ── Set canvas sizes BEFORE chart init — prevents ResizeObserver loop ──
  var trendEl = document.getElementById('trendChart');
  var toolEl  = document.getElementById('toolChart');
  trendEl.width  = 580;
  trendEl.height = 280;
  trendEl.style.height = '280px';
  toolEl.width  = 320;
  toolEl.height = 280;
  toolEl.style.height = '280px';

  // ── Tool colour map (Intercom palette) ────────────────────────────────────
  var TOOL_COLORS = {
    'Copilot':           '#1F8EFA',
    'Copilot Agent':     '#3B82F6',
    'Copilot CLI':       '#60A5FA',
    'Claude Code':       '#F97316',
    'Claude Code Agent': '#EA580C',
    'Cursor':            '#8B5CF6',
    'Cursor Agent':      '#7C3AED',
    'ChatGPT Paste':     '#10B981',
    'Codeium':           '#06B6D4',
    'Cline':             '#F59E0B',
    'Aider':             '#84CC16',
    'Continue':          '#14B8A6',
    'AI Agent':          '#6B7280',
    'Unknown':           '#9CA3AF'
  };
  var FALLBACK = ['#1F8EFA','#F97316','#8B5CF6','#10B981','#F59E0B','#9CA3AF','#06B6D4'];

  // ── Daily trend — line chart ──────────────────────────────────────────────
  var ctx1 = trendEl.getContext('2d');
  new Chart(ctx1, {
    type: 'line',
    data: {
      labels: DATA.perDayTrend.map(function(d) { return d.date; }),
      datasets: [
        {
          label: 'Human Lines',
          data: DATA.perDayTrend.map(function(d) { return d.humanLines; }),
          borderColor: '#1F8EFA',
          backgroundColor: 'rgba(31,142,250,.08)',
          fill: true, tension: 0.35, pointRadius: 3,
          pointBackgroundColor: '#1F8EFA'
        },
        {
          label: 'AI Lines',
          data: DATA.perDayTrend.map(function(d) { return d.aiLines; }),
          borderColor: '#F59E0B',
          backgroundColor: 'rgba(245,158,11,.08)',
          fill: true, tension: 0.35, pointRadius: 3,
          pointBackgroundColor: '#F59E0B'
        }
      ]
    },
    options: {
      responsive: false,
      animation: false,
      plugins: {
        legend: { position: 'top', labels: { color: '#6B7280', boxWidth: 12, padding: 16 } }
      },
      scales: {
        y: { beginAtZero: true, grid: { color: '#F3F4F6' }, ticks: { color: '#6B7280' } },
        x: { grid: { display: false }, ticks: { color: '#6B7280', maxTicksLimit: 8 } }
      }
    }
  });

  // ── Tool breakdown — doughnut ─────────────────────────────────────────────
  var tools = Object.keys(DATA.perToolBreakdown);
  var toolColors = tools.map(function(t, i) {
    return TOOL_COLORS[t] || FALLBACK[i % FALLBACK.length];
  });
  var ctx2 = toolEl.getContext('2d');
  new Chart(ctx2, {
    type: 'doughnut',
    data: {
      labels: tools,
      datasets: [{
        data: tools.map(function(t) { return DATA.perToolBreakdown[t]; }),
        backgroundColor: toolColors,
        borderWidth: 2,
        borderColor: '#ffffff'
      }]
    },
    options: {
      responsive: false,
      animation: false,
      cutout: '65%',
      plugins: {
        legend: { position: 'bottom', labels: { color: '#6B7280', boxWidth: 12, padding: 12 } },
        tooltip: {
          callbacks: {
            label: function(ctx) { return ' ' + ctx.label + ': ' + ctx.raw.toFixed(1) + '%'; }
          }
        }
      }
    }
  });

  // ── Sortable heatmap table ────────────────────────────────────────────────
  var table = document.getElementById('heatmapTable');
  if (table) {
    var tbody = table.querySelector('tbody');
    var lastCol = 'pct', lastDir = -1;
    table.querySelectorAll('th[data-col]').forEach(function(th) {
      th.addEventListener('click', function() {
        var col = th.getAttribute('data-col');
        if (col === lastCol) { lastDir *= -1; } else { lastCol = col; lastDir = -1; }
        table.querySelectorAll('th').forEach(function(h) {
          h.classList.remove('sorted-asc', 'sorted-desc');
        });
        th.classList.add(lastDir === -1 ? 'sorted-desc' : 'sorted-asc');
        var rows = Array.from(tbody.querySelectorAll('tr'));
        rows.sort(function(a, b) {
          var av = a.getAttribute('data-' + col) || '';
          var bv = b.getAttribute('data-' + col) || '';
          var an = parseFloat(av), bn = parseFloat(bv);
          if (!isNaN(an) && !isNaN(bn)) return (an - bn) * lastDir;
          return av.localeCompare(bv) * lastDir;
        });
        rows.forEach(function(r) { tbody.appendChild(r); });
      });
    });
    var pctTh = table.querySelector('th[data-col="pct"]');
    if (pctTh) pctTh.classList.add('sorted-desc');
  }

  // ── Export button ─────────────────────────────────────────────────────────
  document.getElementById('exportBtn').addEventListener('click', function() {
    var blob = new Blob([JSON.stringify(DATA, null, 2)], { type: 'application/json' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = 'brela-report-' + DATA.dateTo + '.json';
    a.click();
    URL.revokeObjectURL(url);
  });

  // ── Dismissible warning banner ────────────────────────────────────────────
  var dismissBtn = document.getElementById('dismissWarning');
  if (dismissBtn) {
    dismissBtn.addEventListener('click', function() {
      var banner = document.getElementById('warningBanner');
      if (banner) banner.style.display = 'none';
    });
  }
});
</script>
</body>
</html>`;
}

function escHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
          .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// ── JSON format ───────────────────────────────────────────────────────────────

function generateJson(m: ReportMetrics): string {
  // perFileHeatmap keeps Maps-as-objects; fileLines is already stripped (not in ReportMetrics)
  return JSON.stringify(m, null, 2);
}

// ── Command factory ───────────────────────────────────────────────────────────

export function reportCommand(): Command {
  return new Command('report')
    .description('Generate an AI attribution report')
    .option('--days <n>', 'analyse last N days', '30')
    .option('--output <path>', 'output HTML file path', './brela-report.html')
    .option('--format <fmt>', 'output format: html | json', 'html')
    .option('--repo <path>', 'project root to analyse', process.cwd())
    .action(async (opts: { days: string; output: string; format: string; repo: string }) => {
      const projectRoot = path.resolve(opts.repo);
      const days = Math.max(1, parseInt(opts.days, 10) || 30);
      const format = opts.format === 'json' ? 'json' : 'html';
      const brelaDir = path.join(projectRoot, '.brela');

      if (!fs.existsSync(brelaDir)) {
        console.log(
          `No .brela/ directory found in ${projectRoot}.\n\n` +
          `Run "brela init" to set up attribution tracking, then:\n` +
          `  • Use your editor — the VS Code extension will log AI insertions\n` +
          `  • Run "brela daemon start" to enable shell-based tracking\n` +
          `  • Commit code — hooks will record AI-attributed commits\n\n` +
          `After collecting a few days of data, run "brela report" again.`
        );
        // Exit 0 — not an error, just no data yet
        throw new BrelaExit(0);
      }

      let metrics;
      try {
        metrics = await computeMetrics(projectRoot, days);
      } catch (err) {
        logError(projectRoot, err);
        throw new BrelaExit(1, `Brela report failed: ${String(err)}`);
      }

      if (format === 'json') {
        process.stdout.write(generateJson(metrics) + '\n');
        return;
      }

      try {
        const chartJs = loadChartJs();
        const html = generateHtml(metrics, chartJs);
        const outPath = path.resolve(opts.output);
        fs.writeFileSync(outPath, html, 'utf8');

        const sizeKb = (fs.statSync(outPath).size / 1024).toFixed(0);
        console.log(`Report written to ${outPath} (${sizeKb} KB)`);
        if (metrics.insufficientData) {
          console.log('  ⚠  Less than 3 days of data — results may not be representative.');
        }

        if (metrics.unreviewedAiCommits.length > 0) {
          console.log(`  ⚑  ${metrics.unreviewedAiCommits.length} unreviewed commits with >60% AI attribution.`);
        }
      } catch (err) {
        logError(projectRoot, err);
        throw new BrelaExit(1, `Brela: failed to write report — ${String(err)}`);
      }
    });
}
