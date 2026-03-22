import * as fs from 'node:fs';
import * as path from 'node:path';
import { Command } from 'commander';
import { BrelaExit } from '../errors.js';

// ── Guard strings ────────────────────────────────────────────────────────────

const PRE_GUARD_BEGIN = '# BRELA PRE-COMMIT BEGIN';
const PRE_GUARD_END = '# BRELA PRE-COMMIT END';
const POST_GUARD_BEGIN = '# BRELA POST-COMMIT BEGIN';
const POST_GUARD_END = '# BRELA POST-COMMIT END';

// ── Hook script bodies ───────────────────────────────────────────────────────
//
// Rules enforced throughout:
//   • Pure POSIX sh — no bashisms, no process substitution
//   • All logic inside a function called with `|| true`
//   • Every external command has stderr redirected or is guarded
//   • Script exits 0 regardless of what brela does

const PRE_COMMIT_BODY = `\
_brela_pre_commit() {
  BRELA_DIR="$PWD/.brela"
  [ -d "$BRELA_DIR" ] || return 0

  SESSION_FILE="$BRELA_DIR/sessions/$(date +%Y-%m-%d).json"
  [ -f "$SESSION_FILE" ] || return 0

  STAGED=$(git diff --cached --name-only 2>/dev/null)
  [ -z "$STAGED" ] && return 0

  # ISO8601 timestamps sort lexicographically — string compare is safe
  # Try GNU date first (Linux), fall back to BSD date (macOS)
  CUTOFF=$(date -u -d '4 hours ago' +%Y-%m-%dT%H:%M:%SZ 2>/dev/null \\
    || date -u -v-4H +%Y-%m-%dT%H:%M:%SZ 2>/dev/null \\
    || echo "0000-00-00T00:00:00Z")

  TIMESTAMP=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  SESSION_ID=$(cat "$BRELA_DIR/current-session" 2>/dev/null | tr -d '[:space:]')
  [ -z "$SESSION_ID" ] && SESSION_ID="unknown"

  FILES_JSON=""
  SEP=""

  # Use heredoc + while-read so filenames with spaces are handled safely
  while IFS= read -r STAGED_FILE; do
    [ -z "$STAGED_FILE" ] && continue

    # Find the last attribution entry for this exact file path
    ENTRY=$(grep -F "\\"file\\":\\"$STAGED_FILE\\"" "$SESSION_FILE" 2>/dev/null | tail -1)
    [ -z "$ENTRY" ] && continue

    # Extract timestamp and apply 4-hour window filter
    TS=$(printf '%s' "$ENTRY" | sed 's/.*"timestamp":"\\([^"]*\\)".*/\\1/')
    # Sanity-check it looks like ISO8601 before comparing
    case "$TS" in
      [0-9][0-9][0-9][0-9]-*T*Z) ;;
      *) continue ;;
    esac
    [ "$TS" \\< "$CUTOFF" ] && continue

    TOOL=$(printf '%s' "$ENTRY" | sed 's/.*"tool":"\\([^"]*\\)".*/\\1/')
    CONF=$(printf '%s' "$ENTRY" | sed 's/.*"confidence":"\\([^"]*\\)".*/\\1/')
    DET=$(printf '%s'  "$ENTRY" | sed 's/.*"detectionMethod":"\\([^"]*\\)".*/\\1/')

    FILES_JSON="\${FILES_JSON}\${SEP}{\\"path\\":\\"\${STAGED_FILE}\\",\\"tool\\":\\"\${TOOL}\\",\\"confidence\\":\\"\${CONF}\\",\\"detectionMethod\\":\\"\${DET}\\"}"
    SEP=","
  done <<BRELA_STAGED_EOF
$STAGED
BRELA_STAGED_EOF

  [ -z "\${FILES_JSON}" ] && return 0

  RECORD="{\\"commitHash\\":\\"pending\\",\\"timestamp\\":\\"\${TIMESTAMP}\\",\\"files\\":[\${FILES_JSON}],\\"sessionId\\":\\"\${SESSION_ID}\\"}"
  printf '%s\\n' "$RECORD" >> "$BRELA_DIR/commits.jsonl" 2>/dev/null
}
_brela_pre_commit || true
`;

const POST_COMMIT_BODY = `\
_brela_post_commit() {
  BRELA_DIR="$PWD/.brela"
  [ -d "$BRELA_DIR" ] || return 0

  COMMITS_FILE="$BRELA_DIR/commits.jsonl"
  [ -f "$COMMITS_FILE" ] || return 0

  HASH=$(git rev-parse HEAD 2>/dev/null)
  [ -z "$HASH" ] && return 0

  # Replace only the LAST "commitHash":"pending" line with the real hash.
  # awk buffers all lines, records the last matching line number, then on END
  # replaces only that line before printing — atomic via temp file + mv.
  TMP=$(mktemp "$BRELA_DIR/.commits.tmp.XXXXXX") || return 0
  awk -v hash="$HASH" '
    { lines[NR] = $0 }
    /"commitHash":"pending"/ { last = NR }
    END {
      for (i = 1; i <= NR; i++) {
        out = lines[i]
        if (i == last) {
          sub(/"commitHash":"pending"/, "\\"commitHash\\":\\"" hash "\\"", out)
        }
        print out
      }
    }
  ' "$COMMITS_FILE" > "\${TMP}" 2>/dev/null \\
    && mv "\${TMP}" "$COMMITS_FILE" 2>/dev/null
  rm -f "\${TMP}" 2>/dev/null
}
_brela_post_commit || true
`;

// ── Low-level hook file manipulation ─────────────────────────────────────────

function readHookFile(hookPath: string): string {
  if (!fs.existsSync(hookPath)) return '';
  return fs.readFileSync(hookPath, 'utf8');
}

function stripGuardBlock(content: string, begin: string, end: string): string {
  // Non-greedy match handles multiple stale blocks from botched earlier runs
  return content
    .replace(new RegExp(`\n?${begin}[\\s\\S]*?${end}\n?`, 'g'), '')
    .trimEnd();
}

function writeHookFile(hookPath: string, content: string): void {
  fs.writeFileSync(hookPath, content, { encoding: 'utf8', mode: 0o755 });
  // Explicit chmod — writeFileSync mode flag doesn't update an existing file's mode
  fs.chmodSync(hookPath, 0o755);
}

function injectBlock(
  existing: string,
  begin: string,
  end: string,
  body: string,
): string {
  // Strip any prior brela section
  const stripped = stripGuardBlock(existing, begin, end);

  // Ensure there's a shebang if we're creating from scratch
  const base =
    stripped.length > 0
      ? stripped
      : '#!/bin/sh';

  return `${base}\n\n${begin}\n${body}${end}\n`;
}

// ── Public install / uninstall ───────────────────────────────────────────────

export function installGitHooks(projectRoot: string): void {
  const hooksDir = path.join(projectRoot, '.git', 'hooks');

  if (!fs.existsSync(hooksDir)) {
    throw new Error(`No .git/hooks directory found in ${projectRoot}`);
  }

  // pre-commit
  const preCommitPath = path.join(hooksDir, 'pre-commit');
  const preContent = injectBlock(
    readHookFile(preCommitPath),
    PRE_GUARD_BEGIN,
    PRE_GUARD_END,
    PRE_COMMIT_BODY,
  );
  writeHookFile(preCommitPath, preContent);

  // post-commit
  const postCommitPath = path.join(hooksDir, 'post-commit');
  const postContent = injectBlock(
    readHookFile(postCommitPath),
    POST_GUARD_BEGIN,
    POST_GUARD_END,
    POST_COMMIT_BODY,
  );
  writeHookFile(postCommitPath, postContent);
}

export function uninstallGitHooks(projectRoot: string): void {
  const hooksDir = path.join(projectRoot, '.git', 'hooks');
  if (!fs.existsSync(hooksDir)) return;

  for (const [hookName, begin, end] of [
    ['pre-commit',  PRE_GUARD_BEGIN,  PRE_GUARD_END],
    ['post-commit', POST_GUARD_BEGIN, POST_GUARD_END],
  ] as const) {
    const hookPath = path.join(hooksDir, hookName);
    if (!fs.existsSync(hookPath)) continue;

    const content = fs.readFileSync(hookPath, 'utf8');
    const stripped = stripGuardBlock(content, begin, end);

    // If only the shebang (or nothing) remains after stripping, remove the file
    const meaningful = stripped.replace(/^#!.*/, '').trim();
    if (!meaningful) {
      fs.rmSync(hookPath, { force: true });
    } else {
      writeHookFile(hookPath, stripped + '\n');
    }
  }
}

// ── Command factory ───────────────────────────────────────────────────────────

export function hookCommand(): Command {
  const cmd = new Command('hook').description('Manage Brela git hook integration');

  cmd
    .command('install')
    .description('Write pre-commit and post-commit hooks into .git/hooks/')
    .action(() => {
      try {
        installGitHooks(process.cwd());
        console.log('Brela git hooks installed (pre-commit + post-commit).');
      } catch (err) {
        throw new BrelaExit(1, `Brela: ${String(err)}`);
      }
    });

  cmd
    .command('uninstall')
    .description('Remove Brela sections from .git/hooks/')
    .action(() => {
      try {
        uninstallGitHooks(process.cwd());
        console.log('Brela git hooks removed.');
      } catch (err) {
        throw new BrelaExit(1, `Brela: ${String(err)}`);
      }
    });

  return cmd;
}
