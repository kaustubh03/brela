#!/usr/bin/env node
import { Command, CommanderError } from 'commander';
import { initCommand } from './commands/init.js';
import { daemonCommand } from './commands/daemon-cmd.js';
import { hookCommand } from './commands/hook.js';
import { reportCommand } from './commands/report.js';
import { BrelaExit } from './errors.js';

const program = new Command();

program
  .name('brela')
  .description('Silent AI code attribution and governance tool')
  .version('0.1.0-alpha.1')
  // Prevent Commander from calling process.exit() itself — we own that.
  .exitOverride();

program.addCommand(initCommand());
program.addCommand(daemonCommand());
program.addCommand(hookCommand());
program.addCommand(reportCommand());

if (!process.argv.slice(2).length) {
  program.outputHelp();
  process.exit(0);
}

// parseAsync properly awaits async action handlers (e.g. `brela report`).
// All process.exit() calls are centralised here.
program.parseAsync().catch((err: unknown) => {
  if (err instanceof BrelaExit) {
    if (err.message) process.stderr.write(err.message + '\n');
    process.exit(err.code);
  }
  if (err instanceof CommanderError) {
    // Commander throws for --help (exit 0), --version (exit 0), and parse errors (exit 1).
    // helpDisplayed / version codes are informational — no extra message needed.
    const silent = err.code === 'commander.helpDisplayed' || err.code === 'commander.version';
    if (!silent) process.stderr.write(err.message + '\n');
    process.exit(err.exitCode);
  }
  // Truly unexpected — surface the full error
  process.stderr.write(`Brela: unexpected error: ${String(err)}\n`);
  process.exit(1);
});
