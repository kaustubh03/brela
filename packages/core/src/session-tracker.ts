import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { AITool } from './types.js';

// ── Configuration ─────────────────────────────────────────────────────────────

export interface SessionConfig {
  /** How long after endSession() files may still be attributed.  Default 10 s. */
  gracePeriodMs: number;
  /** Hard ceiling on session duration — active sessions are force-closed after this. Default 1 h. */
  maxSessionDurationMs: number;
}

const DEFAULT_CONFIG: SessionConfig = {
  gracePeriodMs:        10_000,
  maxSessionDurationMs: 3_600_000,
};

// ── Session model ─────────────────────────────────────────────────────────────

export interface FileRecord {
  firstSeen: number;
  lastSeen:  number;
  diffCount: number;
}

export interface AttributionSession {
  id:                string;
  aiTool:            AITool;
  startedAt:         number;
  endedAt:           number | null;
  gracePeriodEndsAt: number | null;
  filesModified:     Map<string, FileRecord>;
  shellCommand:      string | null;
  status:            'active' | 'grace_period' | 'closed';
}

// ── Events ────────────────────────────────────────────────────────────────────

export interface SessionTrackerEvents {
  'session:started': [session: AttributionSession];
  'session:grace':   [session: AttributionSession];
  'session:closed':  [session: AttributionSession];
}

// ── SessionTracker ────────────────────────────────────────────────────────────

/**
 * In-memory session tracker for AI tool activity.
 *
 * Lifecycle:
 *   startSession()  → status 'active'
 *   endSession()    → status 'grace_period'  (files still attributable during grace window)
 *   closeExpiredSessions() / startSession() → status 'closed'
 *
 * Emits:
 *   'session:started'  when a session moves to active
 *   'session:grace'    when a session moves to grace period
 *   'session:closed'   when a session is closed
 */
export class SessionTracker extends EventEmitter {
  private readonly config: SessionConfig;
  private readonly sessions = new Map<string, AttributionSession>();

  constructor(config?: Partial<SessionConfig>) {
    super();
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /**
   * Open a new session for the given tool.
   * Any currently active or grace-period sessions are closed first.
   */
  startSession(aiTool: AITool, shellCommand?: string): AttributionSession {
    // Close any non-closed sessions before starting a new one
    for (const s of this.sessions.values()) {
      if (s.status !== 'closed') this._forceClose(s);
    }

    const session: AttributionSession = {
      id:                randomUUID(),
      aiTool,
      startedAt:         Date.now(),
      endedAt:           null,
      gracePeriodEndsAt: null,
      filesModified:     new Map(),
      shellCommand:      shellCommand ?? null,
      status:            'active',
    };

    this.sessions.set(session.id, session);
    this.emit('session:started', session);
    return session;
  }

  /**
   * Signal that the AI tool invocation has finished.
   * The session enters the grace period and can still receive file attributions.
   */
  endSession(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session || session.status !== 'active') return;

    const now = Date.now();
    session.endedAt           = now;
    session.gracePeriodEndsAt = now + this.config.gracePeriodMs;
    session.status            = 'grace_period';
    this.emit('session:grace', session);
  }

  /**
   * Record that a file was modified, attributing it to the current session.
   *
   * @param filePath  Absolute or project-relative path.
   * @param timestamp Unix-ms timestamp; defaults to `Date.now()`.
   * @returns         The attributing session ID and attribution tier,
   *                  or `null`/`'unattributed'` if no session is current.
   */
  recordFileChange(
    filePath:   string,
    timestamp?: number,
  ): { sessionId: string | null; attribution: 'in_session' | 'grace_period' | 'unattributed' } {
    const now     = timestamp ?? Date.now();
    const session = this._findCurrentSession(now);

    if (session === null) {
      return { sessionId: null, attribution: 'unattributed' };
    }

    const existing = session.filesModified.get(filePath);
    if (existing) {
      existing.lastSeen  = now;
      existing.diffCount += 1;
    } else {
      session.filesModified.set(filePath, { firstSeen: now, lastSeen: now, diffCount: 1 });
    }

    const attribution: 'in_session' | 'grace_period' =
      session.status === 'active' ? 'in_session' : 'grace_period';

    return { sessionId: session.id, attribution };
  }

  /**
   * Return the current session that would attribute the next file change,
   * or `null` if no active or unexpired grace-period session exists.
   */
  getActiveSession(): AttributionSession | null {
    return this._findCurrentSession(Date.now());
  }

  /** Look up any session by ID (including closed ones). */
  getSession(id: string): AttributionSession | null {
    return this.sessions.get(id) ?? null;
  }

  /**
   * Close all sessions whose grace period has expired,
   * and any active sessions that have exceeded the maximum duration.
   *
   * @returns IDs of sessions that were closed by this call.
   */
  closeExpiredSessions(): string[] {
    const now    = Date.now();
    const closed: string[] = [];

    for (const session of this.sessions.values()) {
      if (session.status === 'closed') continue;

      const graceExpired =
        session.status === 'grace_period' &&
        session.gracePeriodEndsAt !== null &&
        now >= session.gracePeriodEndsAt;

      const durationExceeded =
        session.status === 'active' &&
        now - session.startedAt >= this.config.maxSessionDurationMs;

      if (graceExpired || durationExceeded) {
        this._forceClose(session);
        closed.push(session.id);
      }
    }

    return closed;
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  /**
   * Find the session that should receive file attributions right now.
   * Prefers `active` over `grace_period`; ignores expired grace periods.
   */
  private _findCurrentSession(now: number): AttributionSession | null {
    let gracePeriodCandidate: AttributionSession | null = null;

    for (const session of this.sessions.values()) {
      if (session.status === 'active') return session; // active wins immediately

      if (
        session.status === 'grace_period' &&
        session.gracePeriodEndsAt !== null &&
        now < session.gracePeriodEndsAt
      ) {
        gracePeriodCandidate = session;
      }
    }

    return gracePeriodCandidate;
  }

  /** Unconditionally close a session and emit the event. */
  private _forceClose(session: AttributionSession): void {
    if (session.endedAt === null) session.endedAt = Date.now();
    session.status = 'closed';
    this.emit('session:closed', session);
  }
}
