// ── Public interfaces ──────────────────────────────────────────────────────────

export interface HumanAttributionEvidence {
  /** File paths and timestamps of the changes being evaluated. */
  fileChanges:           Array<{ filePath: string; timestamp: number }>;
  /** Were any AI sessions active during the time range of these changes? */
  activeAISessions:      boolean;
  /** Was the shell wrapper active and monitoring when changes occurred? */
  shellWrapperRunning:   boolean;
  /** Was the file watcher active when changes occurred? */
  fileWatcherRunning:    boolean;
  /** No AI-tool processes were detected writing to the relevant files. */
  processTreeClean:      boolean;
  /** Editor telemetry was running and detected no completion-acceptance events. */
  editorTelemetryClean:  boolean;
  /** 0–1 composite confidence in the verdict. */
  confidence:            number;
  verdict:               'human_authored' | 'insufficient_monitoring' | 'uncertain';
  reasoning:             string[];
}

// ── assessHumanAuthorship ──────────────────────────────────────────────────────

/**
 * Pure function — takes pre-gathered evidence and returns a human-authorship
 * verdict.  No database access, no side effects.
 *
 * Verdict priority (highest first):
 *   1. `insufficient_monitoring` — any monitoring component was inactive
 *   2. `uncertain`               — an AI session overlapped the time range,
 *                                  or an AI process was found writing the files
 *   3. `human_authored`          — all monitors clean, no AI activity detected
 */
export function assessHumanAuthorship(params: {
  filePaths:            string[];
  timeRange:            { start: number; end: number };
  activeSessions:       Array<{ aiTool: string; start: number; end: number }>;
  monitoringStatus:     { shellWrapper: boolean; fileWatcher: boolean; editorTelemetry: boolean };
  processCorrelations:  Array<{ filePath: string; aiTool: string | null }>;
}): HumanAttributionEvidence {
  const { filePaths, timeRange, activeSessions, monitoringStatus, processCorrelations } = params;

  // ── Derive boolean evidence signals ─────────────────────────────────────────

  const shellWrapperRunning  = monitoringStatus.shellWrapper;
  const fileWatcherRunning   = monitoringStatus.fileWatcher;
  // Editor telemetry is "clean" when it was running (and, by absence of events,
  // detected no completion acceptances for the relevant files).
  const editorTelemetryClean = monitoringStatus.editorTelemetry;

  const monitoringComplete =
    shellWrapperRunning && fileWatcherRunning && editorTelemetryClean;

  // Session overlap: any session whose window intersects [timeRange.start, timeRange.end]
  const overlappingSessions = activeSessions.filter(
    s => s.start <= timeRange.end && s.end >= timeRange.start,
  );
  const activeAISessions = overlappingSessions.length > 0;

  // Process tree: any correlation that positively identified an AI tool
  const aiProcessHits = processCorrelations.filter(c => c.aiTool !== null);
  const processTreeClean = aiProcessHits.length === 0;

  // ── Determine verdict ────────────────────────────────────────────────────────

  const reasoning: string[] = [];
  let verdict: HumanAttributionEvidence['verdict'];

  if (!monitoringComplete) {
    verdict = 'insufficient_monitoring';

    if (!shellWrapperRunning) {
      reasoning.push('Shell wrapper was not running — AI CLI invocations cannot be ruled out');
    }
    if (!fileWatcherRunning) {
      reasoning.push('File watcher was not running — AI agent file writes cannot be ruled out');
    }
    if (!editorTelemetryClean) {
      reasoning.push('Editor telemetry was not active — inline completion acceptances cannot be ruled out');
    }
  } else if (activeAISessions) {
    verdict = 'uncertain';

    for (const s of overlappingSessions) {
      reasoning.push(
        `AI session (${s.aiTool}) was active from ${new Date(s.start).toISOString()} ` +
        `to ${new Date(s.end).toISOString()}, overlapping the change window`,
      );
    }
  } else if (!processTreeClean) {
    verdict = 'uncertain';

    for (const hit of aiProcessHits) {
      reasoning.push(
        `AI process (${hit.aiTool}) was detected writing to ${hit.filePath}`,
      );
    }
  } else {
    verdict = 'human_authored';
    reasoning.push('All monitoring components were active and detected no AI activity');
    reasoning.push(`${filePaths.length} file(s) changed with no overlapping AI sessions, AI processes, or completion events`);
  }

  // ── Confidence ───────────────────────────────────────────────────────────────
  //
  // Each active monitoring layer adds to the base score:
  //   shellWrapper    +0.30  (highest: intercepts CLI-level invocations)
  //   fileWatcher     +0.25
  //   editorTelemetry +0.20
  //   processTreeClean +0.15
  //   no AI sessions  +0.10
  //                   ────
  //   max              1.00
  //
  // For `insufficient_monitoring` the total is capped at 0.30.
  // For `uncertain`              the total is capped at 0.40.

  let confidence =
    (shellWrapperRunning   ? 0.30 : 0) +
    (fileWatcherRunning    ? 0.25 : 0) +
    (editorTelemetryClean  ? 0.20 : 0) +
    (processTreeClean      ? 0.15 : 0) +
    (!activeAISessions     ? 0.10 : 0);

  if (verdict === 'insufficient_monitoring') confidence = Math.min(0.30, confidence);
  if (verdict === 'uncertain')               confidence = Math.min(0.40, confidence);

  confidence = Math.round(Math.min(1, Math.max(0, confidence)) * 100) / 100;

  return {
    fileChanges:          filePaths.map(fp => ({ filePath: fp, timestamp: timeRange.start })),
    activeAISessions,
    shellWrapperRunning,
    fileWatcherRunning,
    processTreeClean,
    editorTelemetryClean,
    confidence,
    verdict,
    reasoning,
  };
}
