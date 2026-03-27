import { execFile } from 'node:child_process';
import * as fsp from 'node:fs/promises';
import { AITool } from './types.js';

// ── Thin exec wrapper ─────────────────────────────────────────────────────────
//
// Wraps execFile in a Promise using an explicit callback so the function is
// trivially mockable in tests (avoids util.promisify's custom-symbol bypass).

function execToString(
  cmd: string,
  args: string[],
  options: { timeout?: number } = {},
): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(cmd, args, options, (err, stdout) => {
      resolve(err ? null : stdout);
    });
  });
}

// ── /proc scanner (Linux only) ────────────────────────────────────────────────
//
// Walks /proc/<pid>/fd/ looking for a symlink whose target matches filePath.
// No external binary needed; fails silently if /proc is unavailable or
// permission is denied for a given process.

async function procScanForFile(filePath: string): Promise<number | null> {
  try {
    const entries = await fsp.readdir('/proc');
    for (const entry of entries) {
      if (!/^\d+$/.test(entry)) continue;
      const pid = parseInt(entry, 10);
      if (isNaN(pid)) continue;
      try {
        const fds = await fsp.readdir(`/proc/${pid}/fd`);
        for (const fd of fds) {
          try {
            const target = await fsp.readlink(`/proc/${pid}/fd/${fd}`);
            if (target === filePath) return pid;
          } catch {
            // fd closed or permission denied — skip
          }
        }
      } catch {
        // Process exited or permission denied — skip
      }
    }
  } catch {
    // /proc not available
  }
  return null;
}

// ── Internal process info resolver ───────────────────────────────────────────
//
// Returns both the short process name and the full command line so that
// matchProcessToAITool can use the cmdline for disambiguation (e.g. to tell
// apart a "node" process running Copilot from one running Aider).

interface ProcessInfo {
  name: string;
  cmdline: string;
}

async function resolveProcessInfo(pid: number): Promise<ProcessInfo | null> {
  try {
    if (process.platform === 'linux') {
      const name = (await fsp.readFile(`/proc/${pid}/comm`, 'utf8')).trim();
      if (!name) return null;
      const rawCmdline = await fsp.readFile(`/proc/${pid}/cmdline`, 'utf8');
      // cmdline is NUL-separated; join with spaces for substring matching
      const cmdline = rawCmdline.split('\0').filter(Boolean).join(' ');
      return { name, cmdline };
    }

    if (process.platform === 'darwin') {
      const stdout = await execToString('ps', ['-p', String(pid), '-o', 'comm='], { timeout: 3000 });
      if (!stdout) return null;
      const name = stdout.trim();
      if (!name) return null;
      // On macOS we only get the process name from ps comm=; reuse it as cmdline
      return { name, cmdline: name };
    }

    return null; // unsupported platform
  } catch {
    return null;
  }
}

// ── Process-name → AITool mapping ─────────────────────────────────────────────
//
// Rules are checked in order; the first match wins.  Both processName and
// (optional) cmdline comparisons are case-insensitive substring tests.

interface MatchRule {
  /** Substring that must appear in the lowercased process name. */
  nameSubstr: string;
  /** If set, cmdline must also contain this substring (case-insensitive). */
  cmdlineSubstr?: string;
  tool: AITool;
}

const MATCH_RULES: MatchRule[] = [
  // Dedicated CLI binaries — highest specificity
  { nameSubstr: 'aider',    tool: AITool.AIDER },
  { nameSubstr: 'codeium',  tool: AITool.CODEIUM },
  { nameSubstr: 'cline',    tool: AITool.CLINE },
  { nameSubstr: 'continue', tool: AITool.CONTINUE },
  { nameSubstr: 'cursor',   tool: AITool.CURSOR },
  // "claude" executable (Claude Code CLI)
  { nameSubstr: 'claude',   tool: AITool.CLAUDE_CODE },
  // gh CLI running "gh copilot …"
  { nameSubstr: 'gh',       cmdlineSubstr: 'copilot', tool: AITool.COPILOT_CLI },
  // node process — need cmdline to disambiguate the host app
  { nameSubstr: 'node', cmdlineSubstr: 'claude',   tool: AITool.CLAUDE_CODE },
  { nameSubstr: 'node', cmdlineSubstr: 'copilot',  tool: AITool.COPILOT },
  { nameSubstr: 'node', cmdlineSubstr: 'codeium',  tool: AITool.CODEIUM },
  { nameSubstr: 'node', cmdlineSubstr: 'cline',    tool: AITool.CLINE },
  { nameSubstr: 'node', cmdlineSubstr: 'continue', tool: AITool.CONTINUE },
  { nameSubstr: 'node', cmdlineSubstr: 'aider',    tool: AITool.AIDER },
  { nameSubstr: 'node', cmdlineSubstr: 'chatgpt',  tool: AITool.CHATGPT_PASTE },
];

export function matchProcessToAITool(
  processName: string,
  cmdline?: string,
): AITool | null {
  const nameLc    = processName.toLowerCase();
  const cmdlineLc = cmdline?.toLowerCase() ?? '';

  for (const rule of MATCH_RULES) {
    if (!nameLc.includes(rule.nameSubstr)) continue;
    if (rule.cmdlineSubstr !== undefined && !cmdlineLc.includes(rule.cmdlineSubstr)) continue;
    return rule.tool;
  }
  return null;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Try to find the PID of the process currently writing to `filePath`.
 *
 * - Linux:  first scans /proc/<pid>/fd symlinks; falls back to `lsof -t -w`.
 * - macOS:  uses `lsof -t <filePath>`.
 * - Other:  returns null immediately.
 *
 * Never throws — any error yields null.
 */
export async function getFileWriterPID(filePath: string): Promise<number | null> {
  try {
    if (process.platform === 'linux') {
      const procPid = await procScanForFile(filePath);
      if (procPid !== null) return procPid;

      // Fallback: lsof (may not be installed on all Linux systems)
      const stdout = await execToString('lsof', ['-t', '-w', filePath], { timeout: 3000 });
      if (!stdout) return null;
      const pid = parseInt(stdout.trim().split('\n')[0] ?? '', 10);
      return isNaN(pid) ? null : pid;
    }

    if (process.platform === 'darwin') {
      const stdout = await execToString('lsof', ['-t', filePath], { timeout: 3000 });
      if (!stdout) return null;
      const pid = parseInt(stdout.trim().split('\n')[0] ?? '', 10);
      return isNaN(pid) ? null : pid;
    }

    return null; // unsupported platform (Windows, etc.)
  } catch {
    return null;
  }
}

/**
 * Resolve the human-readable name of process `pid`.
 *
 * - Linux:  reads /proc/<pid>/comm.
 * - macOS:  spawns `ps -p <pid> -o comm=`.
 * - Other:  returns null.
 *
 * Never throws.
 */
export async function resolveProcessName(pid: number): Promise<string | null> {
  const info = await resolveProcessInfo(pid);
  return info?.name ?? null;
}

/**
 * Orchestrates getFileWriterPID → resolveProcessName → matchProcessToAITool.
 *
 * Confidence tiers:
 *   0.9  — PID resolved + process name resolved + AI tool matched
 *   0.5  — PID resolved but process name or AI tool not determined
 *   0.0  — no PID found
 */
export async function correlateFileWrite(filePath: string): Promise<{
  pid:         number | null;
  processName: string | null;
  aiTool:      AITool | null;
  confidence:  number;
}> {
  const pid = await getFileWriterPID(filePath);

  if (pid === null) {
    return { pid: null, processName: null, aiTool: null, confidence: 0.0 };
  }

  const info = await resolveProcessInfo(pid);

  if (info === null) {
    return { pid, processName: null, aiTool: null, confidence: 0.5 };
  }

  const aiTool = matchProcessToAITool(info.name, info.cmdline);

  return {
    pid,
    processName: info.name,
    aiTool,
    confidence: aiTool !== null ? 0.9 : 0.5,
  };
}
