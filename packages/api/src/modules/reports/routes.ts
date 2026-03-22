// ── Reports routes ───────────────────────────────────────────────────────────
// CRUD for attribution report snapshots — each report stores the full
// ReportMetrics as a JSONB column alongside denormalised summary fields
// for fast listing and filtering.

import type { FastifyInstance } from 'fastify';
import { getUserClient } from '../../db/client.js';
import { requireAuth } from '../auth/middleware.js';
import { sendError, badRequest, notFound, internal } from '../../utils/errors.js';
import {
  CreateReportBody,
  ListReportsQuery,
  GetReportParams,
} from './schemas.js';
import type { ReportRow } from '../../db/types.js';

function mapReport(r: ReportRow) {
  return {
    id: r.id,
    projectId: r.project_id,
    createdBy: r.created_by,
    daysAnalysed: r.days_analysed,
    dateFrom: r.date_from,
    dateTo: r.date_to,
    aiPercentage: r.ai_percentage,
    totalAiLines: r.total_ai_lines,
    totalHumanLines: r.total_human_lines,
    metrics: r.metrics,
    createdAt: r.created_at,
  };
}

export async function reportRoutes(app: FastifyInstance): Promise<void> {
  // All report routes require authentication
  app.addHook('preHandler', requireAuth);

  // ── POST /reports ─────────────────────────────────────────────────────────
  // Create a new report snapshot.
  app.post<{ Body: typeof CreateReportBody.static }>(
    '/reports',
    { schema: { body: CreateReportBody } },
    async (request, reply) => {
      try {
        const supabase = getUserClient(request.accessToken);
        const body = request.body;

        const { data, error } = await supabase
          .from('reports')
          .insert({
            project_id: body.projectId,
            created_by: request.userId,
            days_analysed: body.daysAnalysed,
            date_from: body.dateFrom,
            date_to: body.dateTo,
            ai_percentage: body.aiPercentage,
            total_ai_lines: body.totalAiLines,
            total_human_lines: body.totalHumanLines,
            metrics: body.metrics,
          })
          .select()
          .single();

        if (error) {
          request.log.error({ error }, 'Failed to create report');
          throw internal(error.message);
        }

        return reply.status(201).send(mapReport(data as ReportRow));
      } catch (err) {
        sendError(reply, err);
      }
    },
  );

  // ── GET /reports ──────────────────────────────────────────────────────────
  // List report summaries for a project (without full metrics JSONB).
  app.get<{ Querystring: typeof ListReportsQuery.static }>(
    '/reports',
    { schema: { querystring: ListReportsQuery } },
    async (request, reply) => {
      try {
        const { projectId, limit = 20, offset = 0 } = request.query;
        if (!projectId) throw badRequest('projectId query parameter is required');

        const supabase = getUserClient(request.accessToken);

        const { data, error, count } = await supabase
          .from('reports')
          .select(
            'id, project_id, created_by, days_analysed, date_from, date_to, ai_percentage, total_ai_lines, total_human_lines, created_at',
            { count: 'exact' },
          )
          .eq('project_id', projectId)
          .order('created_at', { ascending: false })
          .range(offset, offset + limit - 1);

        if (error) throw internal(error.message);

        const reports = ((data ?? []) as ReportRow[]).map((r) => ({
          id: r.id,
          projectId: r.project_id,
          createdBy: r.created_by,
          daysAnalysed: r.days_analysed,
          dateFrom: r.date_from,
          dateTo: r.date_to,
          aiPercentage: r.ai_percentage,
          totalAiLines: r.total_ai_lines,
          totalHumanLines: r.total_human_lines,
          createdAt: r.created_at,
        }));

        return reply.send({ reports, total: count ?? 0 });
      } catch (err) {
        sendError(reply, err);
      }
    },
  );

  // ── GET /reports/:reportId ────────────────────────────────────────────────
  // Get a single report with full metrics.
  app.get<{ Params: typeof GetReportParams.static }>(
    '/reports/:reportId',
    { schema: { params: GetReportParams } },
    async (request, reply) => {
      try {
        const supabase = getUserClient(request.accessToken);

        const { data, error } = await supabase
          .from('reports')
          .select('*')
          .eq('id', request.params.reportId)
          .single();

        if (error || !data) throw notFound('Report not found');

        return reply.send(mapReport(data as ReportRow));
      } catch (err) {
        sendError(reply, err);
      }
    },
  );

  // ── DELETE /reports/:reportId ─────────────────────────────────────────────
  app.delete<{ Params: typeof GetReportParams.static }>(
    '/reports/:reportId',
    { schema: { params: GetReportParams } },
    async (request, reply) => {
      try {
        const supabase = getUserClient(request.accessToken);

        const { error } = await supabase
          .from('reports')
          .delete()
          .eq('id', request.params.reportId)
          .eq('created_by', request.userId);

        if (error) throw internal(error.message);

        return reply.status(204).send();
      } catch (err) {
        sendError(reply, err);
      }
    },
  );
}
