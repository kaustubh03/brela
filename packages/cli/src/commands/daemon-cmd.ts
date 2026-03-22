import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Command } from 'commander';
import { BrelaExit } from '../errors.js';

const PID_FILE = '.brela/daemon.pid';

// Resolve the daemon entry point relative to this file's compiled location.
// Layout: packages/cli/dist/commands/ → ../../.. → packages/ → daemon/dist/daemon.js
function daemonScriptPath(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, '..', '..', '..', 'daemon', 'dist', 'daemon.js');
}

function pidPath(projectRoot: string): string {
  return path.join(projectRoot, PID_FILE);
}

function readPid(projectRoot: string): number | null {
  const p = pidPath(projectRoot);
  if (!fs.existsSync(p)) return null;
  const raw = fs.readFileSync(p, 'utf8').trim();
  const n = parseInt(raw, 10);
  return isNaN(n) ? null : n;
}

function isRunning(pid: number): boolean {
  try {
    // Signal 0 checks existence without sending a real signal
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function startDaemon(projectRoot: string): void {
  const script = daemonScriptPath();

  if (!fs.existsSync(script)) {
    throw new BrelaExit(
      1,
      `Brela: daemon script not found at ${script}\n` +
      `Run "npm run build" in packages/daemon first.`,
    );
  }

  const existingPid = readPid(projectRoot);
  if (existingPid !== null && isRunning(existingPid)) {
    console.log(`Brela daemon is already running (PID ${existingPid}).`);
    return;
  }

  // Ensure .brela/ exists before the daemon tries to write into it
  fs.mkdirSync(path.join(projectRoot, '.brela'), { recursive: true });

  const child = spawn(process.execPath, [script, projectRoot], {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();

  // Give the child a moment to start, then record its PID
  const pid = child.pid;
  if (pid === undefined) {
    throw new BrelaExit(1, 'Brela: failed to spawn daemon process.');
  }

  fs.writeFileSync(pidPath(projectRoot), String(pid), 'utf8');
  console.log(`Brela daemon started (PID ${pid}).`);
}

function stopDaemon(projectRoot: string): void {
  const pid = readPid(projectRoot);

  if (pid === null) {
    console.log('Brela daemon is not running (no PID file).');
    return;
  }

  if (!isRunning(pid)) {
    fs.rmSync(pidPath(projectRoot), { force: true });
    console.log('Brela daemon was not running. PID file cleaned up.');
    return;
  }

  try {
    process.kill(pid, 'SIGTERM');
    fs.rmSync(pidPath(projectRoot), { force: true });
    console.log(`Brela daemon stopped (PID ${pid}).`);
  } catch (err) {
    throw new BrelaExit(1, `Brela: failed to stop daemon — ${String(err)}`);
  }
}

// ── Command factory ──────────────────────────────────────────────────────────

export function daemonCommand(): Command {
  const cmd = new Command('daemon').description('Manage the Brela background watcher');

  cmd
    .command('start')
    .description('Start the daemon in the background')
    .action(() => startDaemon(process.cwd()));

  cmd
    .command('stop')
    .description('Stop the running daemon')
    .action(() => stopDaemon(process.cwd()));

  return cmd;
}
