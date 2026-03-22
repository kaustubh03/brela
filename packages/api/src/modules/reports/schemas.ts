// ── Reports validation schemas (TypeBox) ─────────────────────────────────────

import { Type, type Static } from '@sinclair/typebox';

// ── Request schemas ──────────────────────────────────────────────────────────

export const CreateReportBody = Type.Object({
  projectId: Type.String({ format: 'uuid' }),
  daysAnalysed: Type.Integer({ minimum: 1, maximum: 365 }),
  dateFrom: Type.String({ format: 'date' }),
  dateTo: Type.String({ format: 'date' }),
  aiPercentage: Type.Number({ minimum: 0, maximum: 100 }),
  totalAiLines: Type.Integer({ minimum: 0 }),
  totalHumanLines: Type.Integer({ minimum: 0 }),
  metrics: Type.Record(Type.String(), Type.Unknown()),
});
export type CreateReportBody = Static<typeof CreateReportBody>;

export const ListReportsQuery = Type.Object({
  projectId: Type.String({ format: 'uuid' }),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, default: 20 })),
  offset: Type.Optional(Type.Integer({ minimum: 0, default: 0 })),
});
export type ListReportsQuery = Static<typeof ListReportsQuery>;

export const GetReportParams = Type.Object({
  reportId: Type.String({ format: 'uuid' }),
});
export type GetReportParams = Static<typeof GetReportParams>;

// ── Response schemas ─────────────────────────────────────────────────────────

export const ReportSummary = Type.Object({
  id: Type.String(),
  projectId: Type.String(),
  createdBy: Type.String(),
  daysAnalysed: Type.Integer(),
  dateFrom: Type.String(),
  dateTo: Type.String(),
  aiPercentage: Type.Number(),
  totalAiLines: Type.Integer(),
  totalHumanLines: Type.Integer(),
  createdAt: Type.String(),
});
export type ReportSummary = Static<typeof ReportSummary>;

export const ReportFull = Type.Intersect([
  ReportSummary,
  Type.Object({
    metrics: Type.Record(Type.String(), Type.Unknown()),
  }),
]);
export type ReportFull = Static<typeof ReportFull>;
