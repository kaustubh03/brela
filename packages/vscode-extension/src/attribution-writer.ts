import { SidecarWriter, SessionManager, ModelResolver } from '@brela-dev/core';
import type { AttributionEntry } from '@brela-dev/core';
import type { DetectionResult } from './detector.js';

const DEBUG = process.env['BRELA_DEBUG'] === '1';

function dbg(msg: string): void {
  if (DEBUG) console.log(`[brela] ${msg}`);
}

const modelResolver = new ModelResolver();

export class AttributionWriter {
  private readonly sidecar: SidecarWriter;
  private readonly session: SessionManager;

  constructor(projectRoot: string) {
    this.sidecar = new SidecarWriter(projectRoot);
    this.session = new SessionManager(projectRoot);
  }

  record(filePath: string, projectRoot: string, result: DetectionResult): void {
    try {
      // Normalise to a project-relative path so the report is portable
      const relFile = filePath.startsWith(projectRoot)
        ? filePath.slice(projectRoot.length).replace(/^[\\/]/, '')
        : filePath;

      // Resolve model from config only (no default fallback).
      // In VS Code extension context, SQLite-based resolution may silently fail,
      // so we store undefined rather than a potentially wrong default. brela explain
      // re-resolves missing models at CLI time where SQLite is always available.
      const model = modelResolver.resolveOrNull(result.tool) ?? undefined;

      const entry: AttributionEntry = {
        file: relFile,
        tool: result.tool,
        model,
        confidence: result.confidence,
        detectionMethod: result.detectionMethod,
        linesStart: result.linesStart,
        linesEnd: result.linesEnd,
        charsInserted: result.charsInserted,
        timestamp: new Date().toISOString(),
        sessionId: this.session.getCurrentSession(),
        accepted: true,
      };

      this.sidecar.write(entry);
      dbg(`recorded ${entry.tool} in ${relFile} (${entry.detectionMethod})`);
    } catch {
      // Never crash the editor — swallow silently
    }
  }
}
