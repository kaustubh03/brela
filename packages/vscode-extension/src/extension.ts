import * as path from 'node:path';
import * as vscode from 'vscode';
import { workspace } from 'vscode';
import type { ExtensionContext, FileCreateEvent, TextDocument, TextDocumentChangeEvent, TextDocumentWillSaveEvent } from 'vscode';
import { InsertionDetector, readLatestSnapshotFiles } from './detector.js';
import { AttributionWriter } from './attribution-writer.js';

// Stored per-activation so deactivate() can clean up if needed
let detector: InsertionDetector | null = null;
let writer: AttributionWriter | null = null;
let outputChannel: vscode.OutputChannel;

const DEBUG = process.env['BRELA_DEBUG'] === '1';
const HANDLER_BUDGET_MS = 5;
// Suppress duplicate attributions for the same file within this window (ms).
// Covers VS Code "Keep" / diff-accept events that re-fire text-change or save.
const DEDUP_WINDOW_MS = 5_000;

function getWorkspaceRoot(): string | null {
  return workspace.workspaceFolders?.[0]?.uri.fsPath ?? null;
}

export function activate(context: ExtensionContext): void {
  outputChannel = vscode.window.createOutputChannel('Brela — AI Attribution');

  try {
    const root = getWorkspaceRoot();

    if (root === null) {
      outputChannel.appendLine('[brela] no workspace open — tracking disabled');
      return;
    }

    detector = new InsertionDetector();
    writer = new AttributionWriter(root);

    // Track the most recent change on a document so the save handler can
    // reference it when evaluating CO_AUTHOR_TRAILER.
    let lastChange: { linesStart: number; linesEnd: number; charsInserted: number } | null = null;

    // Tracks files that received an onDidChangeTextDocument event since last
    // save. Used by Listener 3 to identify agent-written saves (no user edits).
    const recentlyChangedDocs = new Set<string>();

    // Dedup: filePath → timestamp of last recorded attribution.
    // Prevents double-entries when VS Code fires extra events on diff-accept / "Keep".
    const lastAttributed = new Map<string, number>();

    function shouldSkip(fsPath: string): boolean {
      const last = lastAttributed.get(fsPath) ?? 0;
      return Date.now() - last < DEDUP_WINDOW_MS;
    }
    function markAttributed(fsPath: string): void {
      lastAttributed.set(fsPath, Date.now());
    }

    // --- Listener 1: text document changes (Rules A, B-burst, C) ---
    const changeDisposable = workspace.onDidChangeTextDocument(
      (event: TextDocumentChangeEvent) => {
        // CRITICAL: ignore non-file documents (Output Channel, git, debug console…)
        if (event.document.uri.scheme !== 'file') return;

        // ── Performance guard ───────────────────────────────────────────────
        const t0 = performance.now();

        if (detector === null || writer === null) return;
        if (event.contentChanges.length === 0) return;

        const fsPath = event.document.uri.fsPath;
        const rel    = path.relative(root, fsPath);

        const result = detector.detect(event, root);

        // Always update the burst window (must happen regardless of detect result
        // so the window is accurate across all file changes in the session).
        const burstResult = detector.trackForBurst(fsPath, root);

        if (result !== null) {
          // Inline detection takes priority over burst
          if (!shouldSkip(fsPath)) {
            markAttributed(fsPath); // mark before write to block Listener 3 racing in
            writer.record(fsPath, root, result);
            outputChannel.appendLine(`[brela] ✦ ${result.tool}  ${rel}  (${result.detectionMethod})`);
          }
          lastChange = {
            linesStart:    result.linesStart,
            linesEnd:      result.linesEnd,
            charsInserted: result.charsInserted,
          };
        } else {
          // No inline signal — report burst if the window threshold was crossed
          if (burstResult !== null && !shouldSkip(fsPath)) {
            writer.record(fsPath, root, burstResult);
            markAttributed(fsPath);
            outputChannel.appendLine(`[brela] ✦ ${burstResult.tool}  ${rel}  (MULTI_FILE_BURST)`);
          }
          // Keep lastChange updated so CO_AUTHOR_TRAILER has a plausible range
          const first = event.contentChanges[0];
          if (first !== undefined) {
            const newlines = (first.text.match(/\n/g) ?? []).length;
            lastChange = {
              linesStart:    first.range.start.line,
              linesEnd:      first.range.start.line + newlines,
              charsInserted: first.text.length,
            };
          }
        }

        // Mark this file as having a text-change event so Listener 3 can skip it
        recentlyChangedDocs.add(fsPath);

        const elapsed = performance.now() - t0;
        if (DEBUG && elapsed > HANDLER_BUDGET_MS) {
          outputChannel.appendLine(`[brela] ⚠ handler took ${elapsed.toFixed(2)}ms (budget: ${HANDLER_BUDGET_MS}ms)`);
        }
      },
    );

    // --- Listener 2: will-save (Rule B — CO_AUTHOR_TRAILER) ---
    const saveDisposable = workspace.onWillSaveTextDocument(
      (event: TextDocumentWillSaveEvent) => {
        if (event.document.uri.scheme !== 'file') return;
        if (detector === null || writer === null) return;

        const { linesStart = 0, linesEnd = 0, charsInserted = 0 } = lastChange ?? {};
        const result = detector.checkCoAuthorTrailer(root, linesStart, linesEnd, charsInserted);
        if (result !== null) {
          const rel = path.relative(root, event.document.uri.fsPath);
          writer.record(event.document.uri.fsPath, root, result);
          outputChannel.appendLine(`[brela] ✦ ${result.tool}  ${rel}  (CO_AUTHOR_TRAILER)`);
        }
      },
    );

    // --- Listener 3: did-save (agent — file written directly to disk) ---
    // If a file is saved without a preceding onDidChangeTextDocument, the edit
    // bypassed the text-change pipeline — characteristic of agent-mode tools.
    const didSaveDisposable = workspace.onDidSaveTextDocument(
      (document: TextDocument) => {
        if (detector === null || writer === null) return;
        const fsPath = document.uri.fsPath;

        // Ignore files outside the workspace (e.g. VS Code settings.json)
        if (!fsPath.startsWith(root + path.sep)) return;

        if (!recentlyChangedDocs.has(fsPath)) {
          // Only attribute files listed in the latest Claude snapshot
          const snapshotFiles = readLatestSnapshotFiles(root);
          if (snapshotFiles !== null) {
            const relFile = path.relative(root, fsPath);
            if (!snapshotFiles.has(relFile)) {
              recentlyChangedDocs.delete(fsPath);
              return;
            }
          }

          const result = detector.checkAgentSave(root);
          if (result !== null && !shouldSkip(fsPath)) {
            const rel = path.relative(root, fsPath);
            markAttributed(fsPath); // mark before write to block Listener 1 racing in
            writer.record(fsPath, root, result);
            outputChannel.appendLine(`[brela] ✦ ${result.tool}  ${rel}  (AGENT_SAVE)`);
          }
        }

        // Clear the flag after each save so the next save cycle starts fresh
        recentlyChangedDocs.delete(fsPath);
      },
    );

    // --- Listener 4: file creation (agent tools create new files directly) ---
    const createDisposable = workspace.onDidCreateFiles(
      (event: FileCreateEvent) => {
        if (detector === null || writer === null) return;
        for (const uri of event.files) {
          // Ignore files outside the workspace
          if (!uri.fsPath.startsWith(root + path.sep)) continue;
          if (shouldSkip(uri.fsPath)) continue;
          const result = detector.checkFileCreation(root);
          const rel    = path.relative(root, uri.fsPath);
          markAttributed(uri.fsPath); // mark before write to block any concurrent event
          writer.record(uri.fsPath, root, result);
          outputChannel.appendLine(`[brela] ✦ ${result.tool}  ${rel}  (FILE_CREATE)`);
        }
      },
    );

    context.subscriptions.push(changeDisposable, saveDisposable, didSaveDisposable, createDisposable);
    outputChannel.appendLine(`[brela] active — watching ${root}`);
  } catch (err) {
    outputChannel.appendLine(`[brela] ERROR: ${err}`);
  }
}

export function deactivate(): void {
  outputChannel?.appendLine('[brela] deactivating');
  detector = null;
  writer = null;
}
