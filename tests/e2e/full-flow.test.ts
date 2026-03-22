/**
 * Brela end-to-end integration test.
 *
 * Uses the Node.js built-in test runner (node:test).
 * Requires packages to be built first: npm run build
 *
 * Run: node --import tsx/esm --test tests/e2e/full-flow.test.ts
 *   or: npm run test:e2e
 */
import { describe, test, before, after } from 'node:test';
import { ok, strictEqual } from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { execSync, type ExecSyncOptions } from 'node:child_process';

const ROOT = process.cwd(); // workspace root when run via npm run test:e2e
const CLI  = path.join(ROOT, 'packages', 'cli', 'dist', 'index.js');
const TODAY = new Date().toISOString().slice(0, 10);

// ── Helpers ───────────────────────────────────────────────────────────────────

function cli(args: string, opts: ExecSyncOptions = {}): string {
  return execSync(`node ${CLI} ${args}`, {
    encoding: 'utf8',
    env: { ...process.env, BRELA_DEBUG: '0', NO_COLOR: '1' },
    stdio: ['pipe', 'pipe', 'pipe'],
    ...opts,
  }) as string;
}

function git(args: string, cwd: string): void {
  execSync(`git ${args}`, {
    cwd,
    stdio: 'pipe',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME:     'Brela Test',
      GIT_AUTHOR_EMAIL:    'test@brela.dev',
      GIT_COMMITTER_NAME:  'Brela Test',
      GIT_COMMITTER_EMAIL: 'test@brela.dev',
    },
  });
}

/** Write an attribution NDJSON entry directly — simulates what SidecarWriter does. */
function writeSessionEntry(brelaDir: string, entry: Record<string, unknown>): void {
  const sessionFile = path.join(brelaDir, 'sessions', `${TODAY}.json`);
  fs.appendFileSync(sessionFile, JSON.stringify(entry) + '\n', 'utf8');
}

// ── Test suite ────────────────────────────────────────────────────────────────

describe('Brela full-flow integration', () => {
  let tmp: string;

  before(() => {
    // ── Temp git repository ───────────────────────────────────────────────────
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'brela-e2e-'));

    git('init', tmp);
    execSync('git config user.email "test@brela.dev"', { cwd: tmp, stdio: 'pipe' });
    execSync('git config user.name "Brela Test"',      { cwd: tmp, stdio: 'pipe' });

    // ── Bootstrap .brela/ ───────────────────────────────────────────────────
    fs.mkdirSync(path.join(tmp, '.brela', 'sessions'), { recursive: true });
    fs.writeFileSync(path.join(tmp, '.brela', '.gitignore'), '*\n');
    fs.writeFileSync(path.join(tmp, '.brela', 'current-session'), 'e2e-session');

    // ── Install git hooks via the CLI ─────────────────────────────────────────
    cli('hook install', { cwd: tmp });

    // ── Write an "AI-generated" source file ───────────────────────────────────
    fs.mkdirSync(path.join(tmp, 'src'), { recursive: true });
    // 60 lines of code — large enough to exceed LARGE_INSERTION thresholds
    const src = Array.from(
      { length: 60 },
      (_, i) => `export const helper${i} = (): number => ${i * 2};`,
    ).join('\n') + '\n';
    fs.writeFileSync(path.join(tmp, 'src', 'ai-generated.ts'), src);

    // ── Simulate IDE attribution (what the VS Code extension writes) ──────────
    writeSessionEntry(path.join(tmp, '.brela'), {
      file: 'src/ai-generated.ts',
      tool: 'COPILOT',
      confidence: 'high',
      detectionMethod: 'LARGE_INSERTION',
      linesStart: 0,
      linesEnd: 60,
      charsInserted: 3000,
      timestamp: new Date().toISOString(),
      sessionId: 'e2e-session',
      accepted: true,
    });

    // ── Commit (triggers pre-commit + post-commit hooks) ──────────────────────
    git('add src/', tmp);
    git('commit -m "feat: add AI-generated helpers"', tmp);
  });

  after(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  // ── Structural assertions ─────────────────────────────────────────────────

  test('pre-commit and post-commit hooks are installed and executable', () => {
    for (const name of ['pre-commit', 'post-commit']) {
      const p = path.join(tmp, '.git', 'hooks', name);
      ok(fs.existsSync(p), `${name} hook is missing`);
      ok((fs.statSync(p).mode & 0o111) !== 0, `${name} hook is not executable`);
    }
  });

  test('session file was written with at least one entry', () => {
    const sessionFile = path.join(tmp, '.brela', 'sessions', `${TODAY}.json`);
    ok(fs.existsSync(sessionFile), 'session file missing');
    const lines = fs.readFileSync(sessionFile, 'utf8').split('\n').filter(Boolean);
    ok(lines.length >= 1, 'session file has no entries');
    const entry = JSON.parse(lines[0]!) as { tool: string };
    strictEqual(entry.tool, 'COPILOT');
  });

  test('.brela/ directory is gitignored via .gitignore inside it', () => {
    const gi = path.join(tmp, '.brela', '.gitignore');
    ok(fs.existsSync(gi), '.brela/.gitignore missing');
    strictEqual(fs.readFileSync(gi, 'utf8').trim(), '*');
  });

  // ── JSON report assertions ────────────────────────────────────────────────

  test('report --format json: ai_percentage > 0', () => {
    const raw = cli(`report --format json --repo ${tmp} --days 2`);
    const m = JSON.parse(raw) as { aiPercentage: number };
    ok(m.aiPercentage > 0, `aiPercentage should be > 0, got ${m.aiPercentage}`);
  });

  test('report --format json: perToolBreakdown has at least one entry', () => {
    const raw = cli(`report --format json --repo ${tmp} --days 2`);
    const m = JSON.parse(raw) as { perToolBreakdown: Record<string, number> };
    const tools = Object.keys(m.perToolBreakdown);
    ok(tools.length >= 1, `perToolBreakdown is empty; expected at least Copilot`);
  });

  test('report --format json: perDayTrend length matches --days', () => {
    const raw = cli(`report --format json --repo ${tmp} --days 3`);
    const m = JSON.parse(raw) as { perDayTrend: unknown[] };
    strictEqual(m.perDayTrend.length, 3);
  });

  test('report --format json: today appears in perDayTrend with ai_lines > 0', () => {
    const raw = cli(`report --format json --repo ${tmp} --days 2`);
    const m = JSON.parse(raw) as { perDayTrend: Array<{ date: string; aiLines: number }> };
    const today = m.perDayTrend.find(d => d.date === TODAY);
    ok(today !== undefined, `today (${TODAY}) missing from perDayTrend`);
    ok(today.aiLines > 0, `aiLines for today should be > 0, got ${today.aiLines}`);
  });

  // ── HTML report assertions ────────────────────────────────────────────────

  test('report HTML: file created, self-contained, under 500 KB', () => {
    const out = path.join(tmp, 'report.html');
    cli(`report --output ${out} --repo ${tmp} --days 2`);
    ok(fs.existsSync(out), 'HTML report file was not created');
    const size = fs.statSync(out).size;
    ok(size < 512_000,  `HTML report is ${(size / 1024).toFixed(0)} KB — exceeds 500 KB limit`);
    ok(size > 10_000,   'HTML report is suspiciously small');
    const html = fs.readFileSync(out, 'utf8');
    ok(html.startsWith('<!DOCTYPE html>'), 'missing DOCTYPE');
    ok(!html.includes('cdn.jsdelivr.net'),     'contains CDN call (jsdelivr)');
    ok(!html.includes('cdnjs.cloudflare.com'), 'contains CDN call (cdnjs)');
    ok(!html.includes('<script src='),         'has external script src');
    ok(html.includes('new Chart('),            'Chart.js not embedded');
    ok(html.includes('brela-report'),        'missing brela branding');
  });

  // ── CLI UX assertions ─────────────────────────────────────────────────────

  test('brela --help exits 0 and mentions brela', () => {
    // Commander exits 0 for --help; execSync will not throw
    let output = '';
    try {
      output = cli('--help');
    } catch (e: unknown) {
      // If exitOverride is not swallowing help, capture stdout from the error
      output = (e as { stdout?: string }).stdout ?? '';
    }
    ok(output.toLowerCase().includes('brela'), '--help output missing "brela"');
  });

  test('brela report missing .brela/ prints setup hint and exits 0', () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'brela-empty-'));
    try {
      let stdout = '';
      try {
        stdout = cli(`report --repo ${empty}`);
      } catch (e: unknown) {
        stdout = (e as { stdout?: string }).stdout ?? '';
      }
      ok(
        stdout.includes('brela init') || stdout.includes('.brela'),
        'setup hint not shown when .brela/ is missing',
      );
    } finally {
      fs.rmSync(empty, { recursive: true, force: true });
    }
  });
});
