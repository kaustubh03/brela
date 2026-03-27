// Integration: instantiate in activate(), call start(), pass context
//
//   import { CompletionObserver } from './telemetry-observer';
//
//   export function activate(context: vscode.ExtensionContext): void {
//     const observer = new CompletionObserver(context);
//     observer.start();
//     // Optional: subscribe to attribution events for real-time logging
//     observer.onAttribution(ev => {
//       console.log(`[brela] observer: ${ev.tool} in ${ev.file}, ${ev.range.start.line}–${ev.range.end.line}`);
//     });
//   }

import * as vscode from 'vscode';

// ── Public interfaces ─────────────────────────────────────────────────────────

/**
 * Attribution event emitted each time the observer decides an edit is
 * likely an AI-generated completion acceptance.
 */
export interface AttributionEventPayload {
  /** Display name of the estimated AI tool (e.g. "GitHub Copilot"). */
  tool:      string;
  /** Absolute path of the file that was edited. */
  file:      string;
  /** The VS Code range of the inserted text. */
  range:     vscode.Range;
  timestamp: number;
  /** The inserted text content. */
  text:      string;
}

/**
 * A persisted record of one likely AI-generated editing event,
 * with derived metrics for downstream analysis.
 */
export interface EditorAttributionEvent {
  timestamp:        number;
  filePath:         string;
  linesAdded:       number;
  /** Display name of the most likely active AI extension, or null if ambiguous. */
  estimatedTool:    string | null;
  /** 0–1 confidence estimate. */
  confidence:       number;
  /** Lines-per-second insertion rate. 0 when no prior edit time is available. */
  insertionVelocity: number;
}

// ── Extension catalogue ───────────────────────────────────────────────────────

/**
 * Known AI coding extension IDs → human-readable display names.
 * Ordered from most-specific to least-specific so the first active entry
 * wins in estimateTool().
 */
const AI_EXTENSION_CATALOGUE: ReadonlyArray<{ id: string; name: string }> = [
  { id: 'GitHub.copilot',                    name: 'GitHub Copilot'   },
  { id: 'GitHub.copilot-chat',               name: 'GitHub Copilot'   },
  { id: 'anthropic.claude-code',             name: 'Claude Code'      },
  { id: 'saoudrizwan.claude-dev',            name: 'Cline'            },
  { id: 'continue.continue',                 name: 'Continue'         },
  { id: 'Codeium.codeium',                   name: 'Codeium'          },
  { id: 'codeium.windsurf',                  name: 'Windsurf'         },
  { id: 'anysphere.cursor-always-local',     name: 'Cursor'           },
  { id: 'aider-ai.aider',                    name: 'Aider'            },
];

// ── Detection thresholds ──────────────────────────────────────────────────────

/** Minimum number of newlines in a single change event to qualify as a completion. */
const MULTI_LINE_THRESHOLD = 3;

/** Minimum character length for a multi-line insertion to be considered non-trivial. */
const MIN_INSERTION_CHARS = 60;

/**
 * AI completions appear at a rate well above human typing (~200 ms/line).
 * 200 ms/line  →  5 lines/second.  We flag anything faster than this.
 */
const VELOCITY_THRESHOLD_LPS = 5; // lines per second

/**
 * After a single-character keystroke we suppress velocity-based flags for
 * this window.  Mirrors the debounce used in detector.ts.
 */
const KEYBOARD_DEBOUNCE_MS = 50;

// ── CompletionObserver ────────────────────────────────────────────────────────

export class CompletionObserver {
  // VS Code event emitter for real-time attribution signals
  private readonly _onAttribution = new vscode.EventEmitter<AttributionEventPayload>();
  /** Subscribe to be notified of each detected completion acceptance. */
  readonly onAttribution: vscode.Event<AttributionEventPayload> = this._onAttribution.event;

  // Internal event log (accessible via getEvents / clearEvents)
  private readonly _events: EditorAttributionEvent[] = [];

  // Disposables created in start(); released in stop()
  private readonly _disposables: vscode.Disposable[] = [];

  // Per-file timestamp of the most recent change (ms), used for velocity calc
  private readonly _lastChangeAt = new Map<string, number>();

  // Timestamp of the most recent single-character (human keystroke) event
  private _lastKeyboardAt = 0;

  // AI extensions confirmed present at start() time (extension-id → name)
  private readonly _presentExtensions = new Map<string, string>();

  constructor(private readonly context: vscode.ExtensionContext) {}

  // ── Lifecycle ───────────────────────────────────────────────────────────────

  /**
   * Register all watchers.  Safe to call multiple times — subsequent calls
   * are no-ops if the observer is already running.
   */
  start(): void {
    if (this._disposables.length > 0) return; // already started

    // Strategy B: inventory which AI extensions are installed/active right now
    this._probeExtensions();

    // Strategy A + C: watch all text-document changes
    this._disposables.push(
      vscode.workspace.onDidChangeTextDocument(
        (ev) => this._handleTextChange(ev),
      ),
    );

    // Dispose together with the extension if the caller passes `context`
    this.context.subscriptions.push(...this._disposables);
  }

  /** Dispose all watchers and the event emitter. */
  stop(): void {
    for (const d of this._disposables) d.dispose();
    this._disposables.length = 0;
    this._onAttribution.dispose();
  }

  // ── Public accessors ────────────────────────────────────────────────────────

  /** Return a snapshot of all recorded attribution events. */
  getEvents(): EditorAttributionEvent[] {
    return this._events.slice();
  }

  /** Clear the internal event log. */
  clearEvents(): void {
    this._events.length = 0;
  }

  /**
   * Return which AI extensions were present when start() was called.
   * Keys are extension IDs; values are display names.
   */
  getPresentExtensions(): ReadonlyMap<string, string> {
    return this._presentExtensions;
  }

  // ── Private: extension inventory ────────────────────────────────────────────

  private _probeExtensions(): void {
    this._presentExtensions.clear();
    for (const { id, name } of AI_EXTENSION_CATALOGUE) {
      const ext = vscode.extensions.getExtension(id);
      if (ext !== undefined) {
        this._presentExtensions.set(id, name);
      }
    }
  }

  /**
   * Return the display name of the highest-priority active AI extension,
   * or null if none are currently active.
   *
   * Re-evaluates isActive at call time (not just at start()) so a tool that
   * activates lazily is still detected on the first completion.
   */
  private _estimateTool(): string | null {
    for (const { id, name } of AI_EXTENSION_CATALOGUE) {
      const ext = vscode.extensions.getExtension(id);
      if (ext?.isActive) return name;
    }
    // Fall back to the inventory captured at start() — handles extensions
    // that deactivated after they wrote code (e.g. Copilot ghost-text that
    // was accepted while the extension is no longer isActive).
    if (this._presentExtensions.size > 0) {
      const [, name] = this._presentExtensions.entries().next().value as [string, string];
      return name;
    }
    return null;
  }

  // ── Private: text-change handler ────────────────────────────────────────────

  private _handleTextChange(event: vscode.TextDocumentChangeEvent): void {
    // Ignore non-file documents (Output, git diff, debug console, …)
    if (event.document.uri.scheme !== 'file') return;
    if (event.contentChanges.length === 0) return;

    const filePath = event.document.uri.fsPath;
    const now      = Date.now();

    for (const change of event.contentChanges) {
      const text       = change.text;
      const charCount  = text.length;
      const newlines   = (text.match(/\n/g) ?? []).length;

      // ── Track keyboard events ──────────────────────────────────────────────
      // Single-character insertions are human keystrokes.  Record the time
      // so velocity-based detection can suppress false positives.
      if (charCount === 1 && newlines === 0) {
        this._lastKeyboardAt = now;
        continue;
      }

      // ── Strategy A: multi-line single-event insertion ──────────────────────
      // A completion acceptance or agent paste delivers many lines in ONE change
      // event.  Manual editing virtually never does this.
      const isMultiLine = newlines >= MULTI_LINE_THRESHOLD && charCount >= MIN_INSERTION_CHARS;

      // ── Strategy C: insertion velocity ────────────────────────────────────
      // Even single-line chunks trigger if they appear far faster than a human
      // could type them (>VELOCITY_THRESHOLD_LPS lines/s).
      const lastAt          = this._lastChangeAt.get(filePath) ?? 0;
      const elapsedSec      = lastAt > 0 ? Math.max(0.001, (now - lastAt) / 1_000) : 0;
      const velocity        = elapsedSec > 0 && newlines > 0
        ? newlines / elapsedSec
        : 0;
      const isHighVelocity  = velocity > VELOCITY_THRESHOLD_LPS &&
                              now - this._lastKeyboardAt > KEYBOARD_DEBOUNCE_MS;

      // Update last-change timestamp for this file (always, even if not flagging)
      this._lastChangeAt.set(filePath, now);

      if (!isMultiLine && !isHighVelocity) continue;

      // ── Build attribution event ────────────────────────────────────────────
      const tool       = this._estimateTool();
      const confidence = this._computeConfidence(isMultiLine, isHighVelocity, tool);

      const range = new vscode.Range(
        change.range.start,
        change.range.start.translate(newlines, 0),
      );

      const attrEvent: EditorAttributionEvent = {
        timestamp:         now,
        filePath,
        linesAdded:        newlines,
        estimatedTool:     tool,
        confidence,
        insertionVelocity: velocity,
      };

      this._events.push(attrEvent);

      // Emit real-time signal
      this._onAttribution.fire({
        tool:      tool ?? 'unknown',
        file:      filePath,
        range,
        timestamp: now,
        text,
      });
    }
  }

  // ── Private: confidence calculation ─────────────────────────────────────────

  /**
   * Derive a 0–1 confidence estimate from the signals that fired.
   *
   * Base:     0.50
   * +0.25     if both multi-line AND high-velocity
   * +0.15     if only one of the two signals
   * +0.15     if a specific AI tool was identified
   * −0.15     if tool is null (ambiguous)
   */
  private _computeConfidence(
    isMultiLine:    boolean,
    isHighVelocity: boolean,
    tool:           string | null,
  ): number {
    let score = 0.50;

    if (isMultiLine && isHighVelocity) score += 0.25;
    else if (isMultiLine || isHighVelocity) score += 0.15;

    if (tool !== null) score += 0.15;
    else               score -= 0.15;

    return Math.round(Math.min(1, Math.max(0, score)) * 100) / 100;
  }
}
