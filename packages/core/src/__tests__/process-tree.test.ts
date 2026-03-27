import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { execFile } from 'node:child_process';
import * as fsp from 'node:fs/promises';
import {
  getFileWriterPID,
  resolveProcessName,
  matchProcessToAITool,
  correlateFileWrite,
} from '../process-tree.js';
import { AITool } from '../types.js';

// ── Module-level mocks ────────────────────────────────────────────────────────
//
// vi.mock is hoisted before imports, so these mocks are in place when
// process-tree.ts is first loaded and evaluates execFile/fsp references.

vi.mock('node:child_process', () => ({ execFile: vi.fn() }));
vi.mock('node:fs/promises', () => ({
  readdir:  vi.fn(),
  readlink: vi.fn(),
  readFile: vi.fn(),
}));

// ── Helpers ───────────────────────────────────────────────────────────────────

const mockExecFile = vi.mocked(execFile);
const mockFsp      = vi.mocked(fsp);

/**
 * Make execFile call its callback with (null, stdout, '').
 * The callback is always the last argument regardless of arity.
 */
function stubExecFile(stdout: string): void {
  mockExecFile.mockImplementation((...args: unknown[]) => {
    const cb = args[args.length - 1] as (
      err: null,
      stdout: string,
      stderr: string,
    ) => void;
    cb(null, stdout, '');
    return {} as ReturnType<typeof execFile>;
  });
}

/**
 * Make execFile call its callback with an error.
 */
function stubExecFileError(message = 'spawn error'): void {
  mockExecFile.mockImplementation((...args: unknown[]) => {
    const cb = args[args.length - 1] as (
      err: Error,
      stdout: string,
      stderr: string,
    ) => void;
    cb(new Error(message), '', '');
    return {} as ReturnType<typeof execFile>;
  });
}

/** Override process.platform for the duration of a test. */
function setPlatform(p: NodeJS.Platform): () => void {
  const original = process.platform;
  Object.defineProperty(process, 'platform', { value: p, configurable: true });
  return () =>
    Object.defineProperty(process, 'platform', {
      value: original,
      configurable: true,
    });
}

// ── matchProcessToAITool ──────────────────────────────────────────────────────
// Pure function — no mocks needed.

describe('matchProcessToAITool', () => {
  it('matches "claude" process name → CLAUDE_CODE', () => {
    expect(matchProcessToAITool('claude')).toBe(AITool.CLAUDE_CODE);
  });

  it('matches "Claude" (mixed case) → CLAUDE_CODE', () => {
    expect(matchProcessToAITool('Claude')).toBe(AITool.CLAUDE_CODE);
  });

  it('matches "cursor" → CURSOR', () => {
    expect(matchProcessToAITool('cursor')).toBe(AITool.CURSOR);
  });

  it('matches "aider" → AIDER', () => {
    expect(matchProcessToAITool('aider')).toBe(AITool.AIDER);
  });

  it('matches "codeium" → CODEIUM', () => {
    expect(matchProcessToAITool('codeium')).toBe(AITool.CODEIUM);
  });

  it('matches "cline" → CLINE', () => {
    expect(matchProcessToAITool('cline')).toBe(AITool.CLINE);
  });

  it('matches "continue" → CONTINUE', () => {
    expect(matchProcessToAITool('continue')).toBe(AITool.CONTINUE);
  });

  it('matches node + copilot cmdline → COPILOT', () => {
    expect(matchProcessToAITool('node', '/usr/local/lib/node_modules/copilot-cli/index.js')).toBe(AITool.COPILOT);
  });

  it('matches node + claude cmdline → CLAUDE_CODE', () => {
    expect(matchProcessToAITool('node', '/home/user/.nvm/versions/node/v20/bin/claude')).toBe(AITool.CLAUDE_CODE);
  });

  it('matches node + chatgpt cmdline → CHATGPT_PASTE', () => {
    expect(matchProcessToAITool('node', '/usr/local/bin/chatgpt-cli')).toBe(AITool.CHATGPT_PASTE);
  });

  it('matches "gh" + "copilot" cmdline → COPILOT_CLI', () => {
    expect(matchProcessToAITool('gh', 'gh copilot suggest "ls files"')).toBe(AITool.COPILOT_CLI);
  });

  it('returns null for unrecognised process names', () => {
    expect(matchProcessToAITool('vim')).toBeNull();
    expect(matchProcessToAITool('bash')).toBeNull();
    expect(matchProcessToAITool('python3')).toBeNull();
  });

  it('returns null for "node" with no recognised cmdline substring', () => {
    expect(matchProcessToAITool('node', '/usr/bin/webpack')).toBeNull();
  });

  it('returns null for "gh" without "copilot" in cmdline', () => {
    expect(matchProcessToAITool('gh', 'gh pr list')).toBeNull();
  });

  it('is case-insensitive on cmdline', () => {
    expect(matchProcessToAITool('node', '/usr/bin/COPILOT_SERVER')).toBe(AITool.COPILOT);
  });
});

// ── getFileWriterPID — macOS branch ──────────────────────────────────────────

describe('getFileWriterPID (macOS)', () => {
  let restore: () => void;

  beforeEach(() => {
    restore = setPlatform('darwin');
    vi.clearAllMocks();
  });

  afterEach(() => restore());

  it('returns the first PID from lsof stdout', async () => {
    stubExecFile('5678\n9999\n');
    const pid = await getFileWriterPID('/tmp/test.ts');
    expect(pid).toBe(5678);
  });

  it('passes correct lsof arguments', async () => {
    stubExecFile('1234\n');
    await getFileWriterPID('/some/path/foo.ts');
    expect(mockExecFile).toHaveBeenCalledWith(
      'lsof',
      ['-t', '/some/path/foo.ts'],
      expect.objectContaining({ timeout: 3000 }),
      expect.any(Function),
    );
  });

  it('returns null when lsof produces empty output', async () => {
    stubExecFile('');
    expect(await getFileWriterPID('/tmp/x.ts')).toBeNull();
  });

  it('returns null when lsof stdout is only whitespace', async () => {
    stubExecFile('   \n  ');
    expect(await getFileWriterPID('/tmp/x.ts')).toBeNull();
  });

  it('returns null when lsof exits with an error', async () => {
    stubExecFileError('No such file');
    expect(await getFileWriterPID('/tmp/missing.ts')).toBeNull();
  });

  it('never throws even if execFile throws synchronously', async () => {
    mockExecFile.mockImplementation(() => { throw new Error('boom'); });
    await expect(getFileWriterPID('/tmp/x.ts')).resolves.toBeNull();
  });
});

// ── getFileWriterPID — Linux branch ──────────────────────────────────────────

describe('getFileWriterPID (Linux)', () => {
  let restore: () => void;

  beforeEach(() => {
    restore = setPlatform('linux');
    vi.clearAllMocks();
  });

  afterEach(() => restore());

  it('returns PID found via /proc scan without calling lsof', async () => {
    // /proc contains two numeric entries; first has no match, second matches
    mockFsp.readdir.mockImplementation((p: unknown) => {
      if (p === '/proc')            return Promise.resolve(['1', '42', 'net'] as unknown as string[]);
      if (p === '/proc/1/fd')       return Promise.resolve(['0', '1', '2'] as unknown as string[]);
      if (p === '/proc/42/fd')      return Promise.resolve(['3'] as unknown as string[]);
      return Promise.reject(new Error('ENOENT'));
    });
    mockFsp.readlink.mockImplementation((p: unknown) => {
      if (p === '/proc/1/fd/0')  return Promise.resolve('/dev/null');
      if (p === '/proc/1/fd/1')  return Promise.resolve('/dev/null');
      if (p === '/proc/1/fd/2')  return Promise.resolve('/dev/null');
      if (p === '/proc/42/fd/3') return Promise.resolve('/workspace/src/index.ts');
      return Promise.reject(new Error('ENOENT'));
    });

    const pid = await getFileWriterPID('/workspace/src/index.ts');
    expect(pid).toBe(42);
    expect(mockExecFile).not.toHaveBeenCalled(); // /proc scan succeeded
  });

  it('falls back to lsof when /proc scan finds no match', async () => {
    // /proc entries but none match the target file
    mockFsp.readdir.mockImplementation((p: unknown) => {
      if (p === '/proc')       return Promise.resolve(['1'] as unknown as string[]);
      if (p === '/proc/1/fd')  return Promise.resolve(['0'] as unknown as string[]);
      return Promise.reject(new Error('ENOENT'));
    });
    mockFsp.readlink.mockResolvedValue('/dev/null');
    stubExecFile('9001\n');

    const pid = await getFileWriterPID('/workspace/main.go');
    expect(pid).toBe(9001);
    expect(mockExecFile).toHaveBeenCalledWith(
      'lsof',
      ['-t', '-w', '/workspace/main.go'],
      expect.objectContaining({ timeout: 3000 }),
      expect.any(Function),
    );
  });

  it('falls back to lsof when /proc readdir rejects', async () => {
    mockFsp.readdir.mockRejectedValue(new Error('EPERM'));
    stubExecFile('7777\n');
    expect(await getFileWriterPID('/tmp/y.py')).toBe(7777);
  });

  it('returns null when both /proc scan and lsof fail', async () => {
    mockFsp.readdir.mockRejectedValue(new Error('EPERM'));
    stubExecFileError();
    expect(await getFileWriterPID('/tmp/z.rs')).toBeNull();
  });
});

// ── getFileWriterPID — unsupported platform ───────────────────────────────────

describe('getFileWriterPID (unsupported platform)', () => {
  let restore: () => void;

  beforeEach(() => { restore = setPlatform('win32'); vi.clearAllMocks(); });
  afterEach(() => restore());

  it('returns null without calling any subprocess or fs', async () => {
    expect(await getFileWriterPID('C:\\foo\\bar.ts')).toBeNull();
    expect(mockExecFile).not.toHaveBeenCalled();
  });
});

// ── resolveProcessName — macOS branch ────────────────────────────────────────

describe('resolveProcessName (macOS)', () => {
  let restore: () => void;

  beforeEach(() => { restore = setPlatform('darwin'); vi.clearAllMocks(); });
  afterEach(() => restore());

  it('returns the trimmed process name from ps output', async () => {
    stubExecFile('node\n');
    expect(await resolveProcessName(1234)).toBe('node');
  });

  it('passes correct ps arguments', async () => {
    stubExecFile('cursor\n');
    await resolveProcessName(999);
    expect(mockExecFile).toHaveBeenCalledWith(
      'ps',
      ['-p', '999', '-o', 'comm='],
      expect.objectContaining({ timeout: 3000 }),
      expect.any(Function),
    );
  });

  it('returns null when ps produces empty output', async () => {
    stubExecFile('');
    expect(await resolveProcessName(1234)).toBeNull();
  });

  it('returns null when ps exits with error (PID not found)', async () => {
    stubExecFileError('No such process');
    expect(await resolveProcessName(99999)).toBeNull();
  });
});

// ── resolveProcessName — Linux branch ────────────────────────────────────────

describe('resolveProcessName (Linux)', () => {
  let restore: () => void;

  beforeEach(() => { restore = setPlatform('linux'); vi.clearAllMocks(); });
  afterEach(() => restore());

  it('reads /proc/<pid>/comm for the process name', async () => {
    mockFsp.readFile.mockImplementation((p: unknown) => {
      if (p === '/proc/42/comm')    return Promise.resolve('claude\n');
      if (p === '/proc/42/cmdline') return Promise.resolve('/usr/local/bin/claude\0--dangerously-skip-permissions\0');
      return Promise.reject(new Error('ENOENT'));
    });

    expect(await resolveProcessName(42)).toBe('claude');
    expect(mockExecFile).not.toHaveBeenCalled();
  });

  it('returns null when /proc/<pid>/comm is empty', async () => {
    mockFsp.readFile.mockImplementation((p: unknown) => {
      if (p === '/proc/1/comm')    return Promise.resolve('   \n');
      if (p === '/proc/1/cmdline') return Promise.resolve('');
      return Promise.reject(new Error('ENOENT'));
    });
    expect(await resolveProcessName(1)).toBeNull();
  });

  it('returns null when /proc/<pid>/comm cannot be read', async () => {
    mockFsp.readFile.mockRejectedValue(new Error('EACCES'));
    expect(await resolveProcessName(1)).toBeNull();
  });
});

// ── correlateFileWrite ────────────────────────────────────────────────────────

describe('correlateFileWrite', () => {
  let restore: () => void;

  beforeEach(() => { restore = setPlatform('darwin'); vi.clearAllMocks(); });
  afterEach(() => restore());

  it('returns confidence 0.0 when no PID is found', async () => {
    stubExecFileError(); // lsof fails
    const result = await correlateFileWrite('/tmp/x.ts');
    expect(result).toEqual({ pid: null, processName: null, aiTool: null, confidence: 0.0 });
  });

  it('returns confidence 0.5 when PID found but process name unresolvable', async () => {
    // First execFile call: lsof → PID 1234
    // Second execFile call: ps → error (process already exited)
    mockExecFile.mockImplementationOnce((...args: unknown[]) => {
      const cb = args[args.length - 1] as (e: null, s: string, _: string) => void;
      cb(null, '1234\n', '');
      return {} as ReturnType<typeof execFile>;
    }).mockImplementationOnce((...args: unknown[]) => {
      const cb = args[args.length - 1] as (e: Error, s: string, _: string) => void;
      cb(new Error('No such process'), '', '');
      return {} as ReturnType<typeof execFile>;
    });

    const result = await correlateFileWrite('/tmp/x.ts');
    expect(result.pid).toBe(1234);
    expect(result.processName).toBeNull();
    expect(result.aiTool).toBeNull();
    expect(result.confidence).toBe(0.5);
  });

  it('returns confidence 0.5 when process name found but not an AI tool', async () => {
    // lsof → PID 5678, ps → "bash"
    mockExecFile.mockImplementationOnce((...args: unknown[]) => {
      const cb = args[args.length - 1] as (e: null, s: string, _: string) => void;
      cb(null, '5678\n', '');
      return {} as ReturnType<typeof execFile>;
    }).mockImplementationOnce((...args: unknown[]) => {
      const cb = args[args.length - 1] as (e: null, s: string, _: string) => void;
      cb(null, 'bash\n', '');
      return {} as ReturnType<typeof execFile>;
    });

    const result = await correlateFileWrite('/tmp/script.sh');
    expect(result.pid).toBe(5678);
    expect(result.processName).toBe('bash');
    expect(result.aiTool).toBeNull();
    expect(result.confidence).toBe(0.5);
  });

  it('returns confidence 0.9 and the correct AITool when fully resolved', async () => {
    // lsof → PID 9999, ps → "claude"
    mockExecFile.mockImplementationOnce((...args: unknown[]) => {
      const cb = args[args.length - 1] as (e: null, s: string, _: string) => void;
      cb(null, '9999\n', '');
      return {} as ReturnType<typeof execFile>;
    }).mockImplementationOnce((...args: unknown[]) => {
      const cb = args[args.length - 1] as (e: null, s: string, _: string) => void;
      cb(null, 'claude\n', '');
      return {} as ReturnType<typeof execFile>;
    });

    const result = await correlateFileWrite('/workspace/main.ts');
    expect(result.pid).toBe(9999);
    expect(result.processName).toBe('claude');
    expect(result.aiTool).toBe(AITool.CLAUDE_CODE);
    expect(result.confidence).toBe(0.9);
  });

  it('resolves AITool for aider on macOS', async () => {
    mockExecFile.mockImplementationOnce((...args: unknown[]) => {
      const cb = args[args.length - 1] as (e: null, s: string, _: string) => void;
      cb(null, '100\n', '');
      return {} as ReturnType<typeof execFile>;
    }).mockImplementationOnce((...args: unknown[]) => {
      const cb = args[args.length - 1] as (e: null, s: string, _: string) => void;
      cb(null, 'aider\n', '');
      return {} as ReturnType<typeof execFile>;
    });

    const result = await correlateFileWrite('/project/foo.py');
    expect(result.aiTool).toBe(AITool.AIDER);
    expect(result.confidence).toBe(0.9);
  });

  it('resolves COPILOT for a node process with copilot in the name (Linux)', async () => {
    const restoreLinux = setPlatform('linux');

    // /proc scan finds nothing
    mockFsp.readdir.mockImplementation((p: unknown) => {
      if (p === '/proc') return Promise.resolve(['200'] as unknown as string[]);
      if (p === '/proc/200/fd') return Promise.resolve([] as unknown as string[]);
      return Promise.reject(new Error('ENOENT'));
    });

    // lsof fallback → PID 200
    stubExecFile('200\n');

    // /proc/200/comm + cmdline
    mockFsp.readFile.mockImplementation((p: unknown) => {
      if (p === '/proc/200/comm')    return Promise.resolve('node\n');
      if (p === '/proc/200/cmdline') return Promise.resolve('/usr/bin/node\0/home/user/.vscode/extensions/GitHub.copilot/dist/extension.js\0');
      return Promise.reject(new Error('ENOENT'));
    });

    const result = await correlateFileWrite('/workspace/app.ts');
    expect(result.pid).toBe(200);
    expect(result.processName).toBe('node');
    expect(result.aiTool).toBe(AITool.COPILOT);
    expect(result.confidence).toBe(0.9);

    restoreLinux();
  });

  it('never throws on any combination of failures', async () => {
    mockExecFile.mockImplementation(() => { throw new Error('boom'); });
    mockFsp.readdir.mockRejectedValue(new Error('boom'));
    mockFsp.readFile.mockRejectedValue(new Error('boom'));
    await expect(correlateFileWrite('/tmp/any.ts')).resolves.toBeDefined();
  });
});
