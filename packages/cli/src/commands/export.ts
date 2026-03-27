import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { Command } from 'commander';
import { BrelaExit, logError } from '../errors.js';

// ── Types ─────────────────────────────────────────────────────────────────────

interface CommitFile {
  path: string;
  tool: string;
  model?: string;
  confidence: string;
  detectionMethod: string;
  lineRanges?: Array<{ start: number; end: number }>;
}

interface CommitRecord {
  commitHash: string;
  timestamp: string;
  files: CommitFile[];
  sessionId: string;
}

// ── Git helpers ───────────────────────────────────────────────────────────────

function gitExec(args: string[], cwd: string): { ok: boolean; stdout: string; stderr: string } {
  const result = spawnSync('git', args, { encoding: 'utf8', cwd });
  return {
    ok: result.status === 0,
    stdout: result.stdout?.trim() ?? '',
    stderr: result.stderr?.trim() ?? '',
  };
}

function isGitRepo(projectRoot: string): boolean {
  return fs.existsSync(path.join(projectRoot, '.git'));
}

// ── Note format ───────────────────────────────────────────────────────────────

interface NotePayload {
  v: number;
  session: string;
  ts: string;
  files: Array<{
    path: string;
    tool: string;
    model: string;
    confidence: string;
    lineRanges?: Array<[number, number]>; // compact: [[start,end], ...]
  }>;
}

function buildNoteJson(record: CommitRecord): string {
  const payload: NotePayload = {
    v: 1,
    session: record.sessionId,
    ts: record.timestamp,
    files: record.files.map((f) => ({
      path: f.path,
      tool: f.tool,
      model: f.model ?? 'unknown',
      confidence: f.confidence,
      ...(f.lineRanges && f.lineRanges.length > 0
        ? { lineRanges: f.lineRanges.map((r) => [r.start, r.end] as [number, number]) }
        : {}),
    })),
  };
  return JSON.stringify(payload);
}

// ── ANSI helpers ──────────────────────────────────────────────────────────────

const NO_COLOR = !!process.env['NO_COLOR'];
function c(code: string, t: string) { return NO_COLOR ? t : `\x1b[${code}m${t}\x1b[0m`; }
const green  = (t: string) => c('32', t);
const red    = (t: string) => c('31', t);
const dim    = (t: string) => c('2',  t);
const bold   = (t: string) => c('1',  t);
const yellow = (t: string) => c('33', t);

// ── Command ───────────────────────────────────────────────────────────────────

export function exportCommand(): Command {
  return new Command('export')
    .description('Export attribution data out of .brela/')
    .option('--git-notes', 'attach attribution as git notes to each attributed commit')
    .option('--push', 'push git notes to remote after attaching (requires --git-notes)')
    .option('--ref <name>', 'git notes ref name', 'brela')
    .option('--remote <name>', 'git remote to push to', 'origin')
    .option('--repo <path>', 'project root path', process.cwd())
    .action(async (opts: {
      gitNotes?: boolean;
      push?: boolean;
      ref: string;
      remote: string;
      repo: string;
    }) => {
      if (!opts.gitNotes) {
        process.stdout.write(
          'No export format specified. Available flags:\n' +
          '  --git-notes   Attach attribution as git notes to each attributed commit\n\n' +
          'Example:\n' +
          '  brela export --git-notes\n' +
          '  brela export --git-notes --push\n',
        );
        return;
      }

      const projectRoot = path.resolve(opts.repo);
      const brelaDir    = path.join(projectRoot, '.brela');
      const commitsFile = path.join(brelaDir, 'commits.jsonl');

      if (!fs.existsSync(brelaDir)) {
        throw new BrelaExit(1,
          `No .brela/ directory found in ${projectRoot}.\n` +
          `Run "brela init" first.`,
        );
      }

      if (!isGitRepo(projectRoot)) {
        throw new BrelaExit(1, `${projectRoot} is not a git repository.`);
      }

      if (!fs.existsSync(commitsFile)) {
        process.stdout.write(
          'No commits.jsonl found — no committed attribution data to export yet.\n' +
          'Attribution is recorded when you commit files tracked by brela.\n',
        );
        return;
      }

      // ── Parse commits.jsonl ─────────────────────────────────────────────
      const records: CommitRecord[] = fs
        .readFileSync(commitsFile, 'utf8')
        .split('\n')
        .filter((l) => l.trim())
        .flatMap((l) => {
          try { return [JSON.parse(l) as CommitRecord]; } catch { return []; }
        });

      if (records.length === 0) {
        process.stdout.write('commits.jsonl is empty — nothing to export.\n');
        return;
      }

      // ── Verify commits exist in the repo ─────────────────────────────
      const notesRef = opts.ref;
      let attached = 0;
      let skipped  = 0;
      let failed   = 0;

      process.stdout.write(
        bold(`Attaching git notes (refs/notes/${notesRef})…`) + '\n\n',
      );

      for (const record of records) {
        const hash = record.commitHash;

        // Check the commit exists
        const check = gitExec(['cat-file', '-t', hash], projectRoot);
        if (!check.ok || check.stdout !== 'commit') {
          process.stdout.write(`  ${dim('·')}  ${dim(hash.slice(0, 7))}  ${dim('commit not found — skipped')}\n`);
          skipped++;
          continue;
        }

        const noteJson = buildNoteJson(record);
        const result = gitExec(
          ['notes', `--ref=${notesRef}`, 'add', '-f', '-m', noteJson, hash],
          projectRoot,
        );

        const shortHash = hash.slice(0, 7);
        const fileCount = record.files.length;
        const tools = [...new Set(record.files.map((f) => f.tool))].join(', ');
        const label = `${shortHash}  ${dim(`${fileCount} file${fileCount !== 1 ? 's' : ''} · ${tools}`)}`;

        if (result.ok) {
          process.stdout.write(`  ${green('✓')}  ${label}\n`);
          attached++;
        } else {
          process.stdout.write(`  ${red('✗')}  ${label}  ${red(result.stderr)}\n`);
          failed++;
        }
      }

      // ── Summary ─────────────────────────────────────────────────────────
      process.stdout.write('\n');
      if (attached > 0) {
        process.stdout.write(
          green(`✓ ${attached} note${attached !== 1 ? 's' : ''} attached to refs/notes/${notesRef}`) + '\n',
        );
      }
      if (skipped > 0) {
        process.stdout.write(dim(`  ${skipped} skipped (commit not in repo)\n`));
      }
      if (failed > 0) {
        process.stdout.write(red(`  ${failed} failed\n`));
      }

      // ── Push ────────────────────────────────────────────────────────────
      if (opts.push && attached > 0) {
        process.stdout.write(`\nPushing refs/notes/${notesRef} to ${opts.remote}…\n`);
        const pushResult = gitExec(
          ['push', opts.remote, `refs/notes/${notesRef}`],
          projectRoot,
        );
        if (pushResult.ok) {
          process.stdout.write(green(`✓ Pushed to ${opts.remote}\n`));
        } else {
          process.stdout.write(red(`✗ Push failed: ${pushResult.stderr}\n`));
          throw new BrelaExit(1);
        }
      } else if (attached > 0 && !opts.push) {
        process.stdout.write(
          '\n' +
          dim('To share notes with the team:\n') +
          `  git push ${opts.remote} refs/notes/${notesRef}\n\n` +
          dim('For teammates to pull notes:\n') +
          `  git fetch ${opts.remote} refs/notes/${notesRef}:refs/notes/${notesRef}\n` +
          `  git log --show-notes=${notesRef}\n`,
        );
      }

      if (failed > 0) throw new BrelaExit(1);
    });
}
