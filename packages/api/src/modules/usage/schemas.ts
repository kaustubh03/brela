// ── Usage data validation schemas (TypeBox) ──────────────────────────────────

import { Type, type Static } from '@sinclair/typebox';

// ── Ingest — batch of attribution entries from CLI/daemon ────────────────────

export const AttributionEventInput = Type.Object({
  file: Type.String(),
  tool: Type.String(),
  confidence: Type.Union([
    Type.Literal('high'),
    Type.Literal('medium'),
    Type.Literal('low'),
  ]),
  detectionMethod: Type.String(),
  linesStart: Type.Integer({ minimum: 0 }),
  linesEnd: Type.Integer({ minimum: 0 }),
  charsInserted: Type.Integer({ minimum: 0 }),
  sessionId: Type.String(),
  accepted: Type.Optional(Type.Boolean()),
  timestamp: Type.String({ format: 'date-time' }),
});
export type AttributionEventInput = Static<typeof AttributionEventInput>;

export const IngestBody = Type.Object({
  projectId: Type.String({ format: 'uuid' }),
  events: Type.Array(AttributionEventInput, { minItems: 1, maxItems: 500 }),
});
export type IngestBody = Static<typeof IngestBody>;

// ── Query ────────────────────────────────────────────────────────────────────

export const UsageQuery = Type.Object({
  projectId: Type.String({ format: 'uuid' }),
  from: Type.Optional(Type.String({ format: 'date' })),
  to: Type.Optional(Type.String({ format: 'date' })),
  tool: Type.Optional(Type.String()),
  groupBy: Type.Optional(
    Type.Union([Type.Literal('day'), Type.Literal('tool'), Type.Literal('user')]),
  ),
});
export type UsageQuery = Static<typeof UsageQuery>;

// ── Response ─────────────────────────────────────────────────────────────────

export const UsageSummaryItem = Type.Object({
  date: Type.Optional(Type.String()),
  tool: Type.Optional(Type.String()),
  userId: Type.Optional(Type.String()),
  totalLines: Type.Integer(),
  totalChars: Type.Integer(),
  eventCount: Type.Integer(),
});
export type UsageSummaryItem = Static<typeof UsageSummaryItem>;

export const IngestResponse = Type.Object({
  inserted: Type.Integer(),
});
export type IngestResponse = Static<typeof IngestResponse>;
