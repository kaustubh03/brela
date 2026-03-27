import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { Command } from 'commander';
import { installGitHooks } from './hook.js';
import { BrelaExit } from '../errors.js';

// ── ANSI helpers ─────────────────────────────────────────────────────────────

const GREEN = '\x1b[32m';
const RED   = '\x1b[31m';
const DIM   = '\x1b[2m';
const BOLD  = '\x1b[1m';
const RESET = '\x1b[0m';

const CHECK = `${GREEN}✓${RESET}`;
const CROSS = `${RED}✗${RESET}`;
const SKIP  = `${DIM}–${RESET}`;

// ── Shell hook source blocks ────────────────────────────────────────────────

const BASH_ZSH_BLOCK = `
# Record a completed AI session: touch a marker before, find changed files after.
# _brela_session <log-name> <binary> [args...]
# Uses $$ (shell PID) for a unique marker so concurrent sessions don't collide.
_brela_session() {
  local _logname="$1"; local _bin="$2"; shift 2
  local _args="$*"
  local _mark="$PWD/.brela/.mark-$$"
  mkdir -p "$PWD/.brela" 2>/dev/null
  touch "$_mark" 2>/dev/null
  command "$_bin" "$@"
  local _changed
  _changed=$(find "$PWD" -newer "$_mark" -type f \\
    -not -path "*/.brela/*" -not -path "*/.git/*" -not -path "*/node_modules/*" \\
    2>/dev/null | tr '\\n' '|')
  echo "{\\"tool\\":\\"$_logname\\",\\"args\\":\\"$_args\\",\\"timestamp\\":\\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\\",\\"pwd\\":\\"$PWD\\",\\"changedFiles\\":\\"$_changed\\"}" \\
    >> "$PWD/.brela/shell-sessions.jsonl" 2>/dev/null
  rm -f "$_mark" 2>/dev/null
}
claude() { _brela_session claude-code claude "$@"; }
aider()  { _brela_session aider aider "$@"; }

# Copilot CLI (no file writes — just log the intent)
gh() {
  if [ "$1" = "copilot" ]; then
    local _mark="$PWD/.brela/.mark-$$"
    mkdir -p "$PWD/.brela" 2>/dev/null
    touch "$_mark" 2>/dev/null
    command gh "$@"
    local _changed
    _changed=$(find "$PWD" -newer "$_mark" -type f \\
      -not -path "*/.brela/*" -not -path "*/.git/*" -not -path "*/node_modules/*" \\
      2>/dev/null | tr '\\n' '|')
    echo "{\\"tool\\":\\"copilot-cli\\",\\"args\\":\\"$*\\",\\"timestamp\\":\\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\\",\\"pwd\\":\\"$PWD\\",\\"changedFiles\\":\\"$_changed\\"}" \\
      >> "$PWD/.brela/shell-sessions.jsonl" 2>/dev/null
    rm -f "$_mark" 2>/dev/null
  else
    command gh "$@"
  fi
}
`.trimStart();

const FISH_BLOCK = `
function _brela_session
  set -l tool $argv[1]
  set -l args (string join " " $argv[2..-1])
  set -l mark "$PWD/.brela/.mark-$fish_pid"
  mkdir -p "$PWD/.brela" 2>/dev/null
  touch $mark 2>/dev/null
  command $tool $args
  set -l changed (find "$PWD" -newer $mark -type f -not -path "*/.brela/*" -not -path "*/.git/*" -not -path "*/node_modules/*" 2>/dev/null | string join "|")
  set -l ts (date -u +%Y-%m-%dT%H:%M:%SZ)
  echo "{\\"tool\\":\\"$tool\\",\\"args\\":\\"$args\\",\\"timestamp\\":\\"$ts\\",\\"pwd\\":\\"$PWD\\",\\"changedFiles\\":\\"$changed\\"}" >> "$PWD/.brela/shell-sessions.jsonl" 2>/dev/null
  rm -f $mark 2>/dev/null
end

function claude
  _brela_session claude-code $argv
end

function aider
  _brela_session aider $argv
end

function gh
  if test "$argv[1]" = "copilot"
    set -l mark "$PWD/.brela/.mark-$fish_pid"
    mkdir -p "$PWD/.brela" 2>/dev/null
    touch $mark 2>/dev/null
    command gh $argv
    set -l changed (find "$PWD" -newer $mark -type f -not -path "*/.brela/*" -not -path "*/.git/*" -not -path "*/node_modules/*" 2>/dev/null | string join "|")
    set -l ts (date -u +%Y-%m-%dT%H:%M:%SZ)
    echo "{\\"tool\\":\\"copilot-cli\\",\\"args\\":\\"(string join \\" \\" $argv)\\",\\"timestamp\\":\\"$ts\\",\\"pwd\\":\\"$PWD\\",\\"changedFiles\\":\\"$changed\\"}" >> "$PWD/.brela/shell-sessions.jsonl" 2>/dev/null
    rm -f $mark 2>/dev/null
  else
    command gh $argv
  end
end
`.trimStart();

const GUARD_BEGIN = '# BRELA BEGIN';
const GUARD_END = '# BRELA END';

// ── Shell detection ─────────────────────────────────────────────────────────

type ShellKind = 'bash' | 'zsh' | 'fish' | 'unknown';

interface ShellConfig {
  kind: ShellKind;
  rcPath: string;
  block: string;
}

function detectShell(): ShellConfig {
  const shellBin = process.env['SHELL'] ?? '';
  const name = path.basename(shellBin).toLowerCase();
  const home = os.homedir();

  if (name === 'zsh') {
    return { kind: 'zsh', rcPath: path.join(home, '.zshrc'), block: BASH_ZSH_BLOCK };
  }
  if (name === 'bash') {
    return { kind: 'bash', rcPath: path.join(home, '.bashrc'), block: BASH_ZSH_BLOCK };
  }
  if (name === 'fish') {
    const xdg = process.env['XDG_CONFIG_HOME'];
    const fishDir = xdg ? path.join(xdg, 'fish') : path.join(home, '.config', 'fish');
    return { kind: 'fish', rcPath: path.join(fishDir, 'config.fish'), block: FISH_BLOCK };
  }
  return { kind: 'unknown', rcPath: '', block: BASH_ZSH_BLOCK };
}

// ── RC file patching (idempotent) ────────────────────────────────────────────

function patchRcFile(rcPath: string, block: string): void {
  fs.mkdirSync(path.dirname(rcPath), { recursive: true });
  if (!fs.existsSync(rcPath)) {
    fs.writeFileSync(rcPath, '', 'utf8');
  }

  const current = fs.readFileSync(rcPath, 'utf8');

  const stripped = current
    .replace(
      new RegExp(`\\n?${GUARD_BEGIN}[\\s\\S]*?${GUARD_END}\\n?`, 'g'),
      '',
    )
    .trimEnd();

  const patched =
    (stripped.length > 0 ? stripped + '\n' : '') +
    `\n${GUARD_BEGIN}\n${block}${GUARD_END}\n`;

  fs.writeFileSync(rcPath, patched, 'utf8');
}

// ── .brela bootstrap ───────────────────────────────────────────────────────

function bootstrapBrelaDir(projectRoot: string): void {
  const brelaDir = path.join(projectRoot, '.brela');
  try {
    fs.mkdirSync(brelaDir, { recursive: true });
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EACCES' || code === 'EPERM') {
      throw new BrelaExit(
        1,
        `Cannot write to ${brelaDir} (permission denied).\nCheck directory permissions and try again.`,
      );
    }
    throw err;
  }

  // .gitignore — keep session data local
  const gitignorePath = path.join(brelaDir, '.gitignore');
  if (!fs.existsSync(gitignorePath)) {
    fs.writeFileSync(gitignorePath, '*\n', 'utf8');
  }

  // Pre-create sessions dir and sidecar files so they exist immediately
  fs.mkdirSync(path.join(brelaDir, 'sessions'), { recursive: true });
  const intentsPath = path.join(brelaDir, 'shell-intents.jsonl');
  if (!fs.existsSync(intentsPath)) {
    fs.writeFileSync(intentsPath, '', 'utf8');
  }
  const shellSessionsPath = path.join(brelaDir, 'shell-sessions.jsonl');
  if (!fs.existsSync(shellSessionsPath)) {
    fs.writeFileSync(shellSessionsPath, '', 'utf8');
  }
}

// ── VS Code extension install ────────────────────────────────────────────────

interface StepResult {
  label: string;
  ok: boolean;
  /** Additional context shown after the label (dim) */
  note?: string;
}

const MARKETPLACE_URL = 'https://marketplace.visualstudio.com/items?itemName=brela.brela-vscode';
const EXTENSION_ID    = 'brela.brela-vscode';

// Known paths for the VS Code CLI on macOS/Linux
const CODE_CLI_CANDIDATES = [
  'code',
  '/usr/local/bin/code',
  '/usr/bin/code',
  `${os.homedir()}/.local/bin/code`,
  '/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code',
  `${os.homedir()}/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code`,
];

function findCodeCli(): string | null {
  for (const candidate of CODE_CLI_CANDIDATES) {
    // For absolute paths, check file existence first (fast)
    if (candidate.startsWith('/') || candidate.startsWith(os.homedir())) {
      if (!fs.existsSync(candidate)) continue;
    }
    const result = spawnSync(candidate, ['--version'], {
      encoding: 'utf8',
      env: process.env,
    });
    if (result.status === 0) return candidate;
  }
  return null;
}

function installVsCodeExtension(): StepResult {
  const codeCli = findCodeCli();

  if (!codeCli) {
    return {
      label: 'VS Code extension',
      ok: false,
      note: `VS Code CLI not found — install from: ${MARKETPLACE_URL}`,
    };
  }

  // Check if already installed
  const check = spawnSync(codeCli, ['--list-extensions'], {
    encoding: 'utf8',
    env: process.env,
  });
  if (check.stdout?.toLowerCase().includes('brela.brela-vscode')) {
    return { label: 'VS Code extension already installed', ok: true };
  }

  // Install directly from Marketplace — works for any end user
  const result = spawnSync(codeCli, ['--install-extension', EXTENSION_ID], {
    encoding: 'utf8',
    env: process.env,
  });

  if (result.status === 0) {
    return { label: 'VS Code extension installed', ok: true };
  }

  // Marketplace install failed — guide user
  return {
    label: 'VS Code extension',
    ok: false,
    note: `install from: ${MARKETPLACE_URL}`,
  };
}

// ── Daemon launch ────────────────────────────────────────────────────────────

function daemonScriptPath(): string {
  try {
    // When installed via npm, resolve daemon from node_modules
    const req = createRequire(import.meta.url);
    return req.resolve('@brela-dev/daemon');
  } catch {
    // Monorepo dev fallback
    const here = path.dirname(fileURLToPath(import.meta.url));
    return path.resolve(here, '..', '..', '..', 'daemon', 'dist', 'daemon.js');
  }
}

function pidPath(projectRoot: string): string {
  return path.join(projectRoot, '.brela', 'daemon.pid');
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function launchDaemon(projectRoot: string): StepResult {
  const script = daemonScriptPath();

  if (!fs.existsSync(script)) {
    return {
      label: 'Daemon',
      ok: false,
      note: 'could not locate daemon — try reinstalling: npm install -g @brela-dev/cli',
    };
  }

  // Check if already running
  const pp = pidPath(projectRoot);
  if (fs.existsSync(pp)) {
    const raw = fs.readFileSync(pp, 'utf8').trim();
    const existingPid = parseInt(raw, 10);
    if (!isNaN(existingPid) && isProcessRunning(existingPid)) {
      return { label: `Daemon running`, ok: true, note: `PID ${existingPid}` };
    }
    fs.rmSync(pp, { force: true });
  }

  try {
    const child = spawn(process.execPath, [script, projectRoot], {
      detached: true,
      stdio: 'ignore',
    });
    child.unref();

    const pid = child.pid;
    if (pid === undefined) {
      return { label: 'Daemon', ok: false, note: 'failed to spawn process' };
    }

    fs.writeFileSync(pp, String(pid), 'utf8');
    return { label: `Daemon started`, ok: true, note: `PID ${pid}` };
  } catch (err) {
    return { label: 'Daemon', ok: false, note: String(err) };
  }
}

// ── Summary printer ──────────────────────────────────────────────────────────

function printSummary(results: StepResult[], shell: ShellConfig): void {
  console.log('');
  for (const r of results) {
    const icon  = r.ok ? CHECK : (r.note?.startsWith('skipped') ? SKIP : CROSS);
    const label = r.ok ? r.label : `${RED}${r.label}${RESET}`;
    const note  = r.note ? `  ${DIM}${r.note}${RESET}` : '';
    console.log(`  ${icon}  ${label}${note}`);
  }

  const allOk = results.every((r) => r.ok);

  console.log('');
  if (allOk) {
    console.log(`  ${BOLD}Brela is ready.${RESET} Start coding — attribution runs silently.`);
  } else {
    console.log(`  ${BOLD}Brela is partially set up.${RESET} Fix the items above and re-run ${DIM}brela init${RESET}.`);
  }

  if (shell.kind !== 'unknown') {
    console.log(`\n  ${DIM}Reload your shell:  source ${shell.rcPath}${RESET}`);
  }

  console.log('');
}

// ── Command factory ──────────────────────────────────────────────────────────

export function initCommand(): Command {
  return new Command('init')
    .description('Set up Brela: shell hooks, VS Code extension, daemon, and .brela/ directory')
    .action(() => {
      const projectRoot = process.cwd();
      const results: StepResult[] = [];

      // ── Step 1: Shell hooks ──────────────────────────────────────────────
      const shell = detectShell();
      if (shell.kind === 'unknown') {
        results.push({
          label: 'Shell hooks',
          ok: false,
          note: `unrecognised shell (${process.env['SHELL'] ?? 'unset'}) — add hooks manually`,
        });
      } else {
        try {
          patchRcFile(shell.rcPath, shell.block);
          results.push({ label: `Shell hooks installed (${shell.kind})`, ok: true });
        } catch (err) {
          results.push({ label: 'Shell hooks', ok: false, note: String(err) });
        }
      }

      // ── Step 2: .brela/ directory + initial files ──────────────────────
      try {
        bootstrapBrelaDir(projectRoot);
        results.push({ label: '.brela/ directory created', ok: true });
      } catch (err) {
        // If we can't create the dir, bail — nothing else will work
        const msg = err instanceof BrelaExit ? err.message : String(err);
        throw new BrelaExit(1, msg);
      }

      // ── Step 3: Git hooks ────────────────────────────────────────────────
      try {
        installGitHooks(projectRoot);
        results.push({ label: 'Git hooks installed', ok: true });
      } catch {
        results.push({ label: 'Git hooks', ok: false, note: 'skipped (not a git repository)' });
      }

      // ── Step 4: VS Code extension ────────────────────────────────────────
      results.push(installVsCodeExtension());

      // ── Step 5: Daemon ───────────────────────────────────────────────────
      results.push(launchDaemon(projectRoot));

      // ── Summary ──────────────────────────────────────────────────────────
      printSummary(results, shell);
    });
}
