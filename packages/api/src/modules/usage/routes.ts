// ── Usage data routes ────────────────────────────────────────────────────────
// Ingest attribution events from the CLI/daemon and query aggregated usage.
// The ingest endpoint is designed for batch inserts (up to 500 events per call).

import type { FastifyInstance } from 'fastify';
import { getUserClient } from '../../db/client.js';
import { requireAuth } from '../auth/middleware.js';
import { sendError, badRequest, internal } from '../../utils/errors.js';
import { IngestBody, UsageQuery } from './schemas.js';
import type { UsageSummaryRow, AttributionEventRow } from '../../db/types.js';

export async function usageRoutes(app: FastifyInstance): Promise<void> {
  // All usage routes require authentication
  app.addHook('preHandler', requireAuth);

  // ── POST /usage/ingest ────────────────────────────────────────────────────
  // Batch insert attribution events.
  app.post<{ Body: typeof IngestBody.static }>(
    '/usage/ingest',
    { schema: { body: IngestBody } },
    async (request, reply) => {
      try {
        const { projectId, events } = request.body;

        if (events.length === 0) {
          throw badRequest('At least one event is required');
        }

        const supabase = getUserClient(request.accessToken);

        const rows = events.map((e) => ({
          project_id: projectId,
          user_id: request.userId,
          file: e.file,
          tool: e.tool,
          confidence: e.confidence,
          detection_method: e.detectionMethod,
          lines_start: e.linesStart,
          lines_end: e.linesEnd,
          chars_inserted: e.charsInserted,
          session_id: e.sessionId,
          accepted: e.accepted ?? true,
          event_timestamp: e.timestamp,
        }));

        const { error, count } = await supabase
          .from('attribution_events')
          .insert(rows, { count: 'exact' });

        if (error) {
          request.log.error({ error }, 'Failed to ingest attribution events');
          throw internal(error.message);
        }

        return reply.status(201).send({ inserted: count ?? rows.length });
      } catch (err) {
        sendError(reply, err);
      }
    },
  );

  // ── GET /usage ────────────────────────────────────────────────────────────
  // Query aggregated usage data from the pre-computed usage_summaries table.
  app.get<{ Querystring: typeof UsageQuery.static }>(
    '/usage',
    { schema: { querystring: UsageQuery } },
    async (request, reply) => {
      try {
        const { projectId, from, to, tool, groupBy } = request.query;
        if (!projectId) throw badRequest('projectId query parameter is required');

        const supabase = getUserClient(request.accessToken);

        let query = supabase
          .from('usage_summaries')
          .select('date, tool, user_id, total_lines, total_chars, event_count')
          .eq('project_id', projectId)
          .order('date', { ascending: false });

        if (from) query = query.gte('date', from);
        if (to) query = query.lte('date', to);
        if (tool) query = query.eq('tool', tool);

        const { data, error } = await query;

        if (error) throw internal(error.message);

        // Client-side grouping — the pre-aggregated table already has daily
        // granularity so we just reshape based on the requested groupBy.
        const items = ((data ?? []) as UsageSummaryRow[]).map((row) => ({
          date: row.date,
          tool: row.tool,
          userId: row.user_id,
          totalLines: row.total_lines,
          totalChars: row.total_chars,
          eventCount: row.event_count,
        }));

        if (groupBy === 'tool') {
          const grouped = new Map<string, { totalLines: number; totalChars: number; eventCount: number }>();
          for (const item of items) {
            const key = item.tool;
            const existing = grouped.get(key) ?? { totalLines: 0, totalChars: 0, eventCount: 0 };
            existing.totalLines += item.totalLines;
            existing.totalChars += item.totalChars;
            existing.eventCount += item.eventCount;
            grouped.set(key, existing);
          }
          return reply.send({
            data: [...grouped.entries()].map(([t, stats]) => ({ tool: t, ...stats })),
          });
        }

        if (groupBy === 'user') {
          const grouped = new Map<string, { totalLines: number; totalChars: number; eventCount: number }>();
          for (const item of items) {
            const key = item.userId;
            const existing = grouped.get(key) ?? { totalLines: 0, totalChars: 0, eventCount: 0 };
            existing.totalLines += item.totalLines;
            existing.totalChars += item.totalChars;
            existing.eventCount += item.eventCount;
            grouped.set(key, existing);
          }
          return reply.send({
            data: [...grouped.entries()].map(([userId, stats]) => ({ userId, ...stats })),
          });
        }

        // Default: groupBy = 'day' or no grouping — return as-is
        return reply.send({ data: items });
      } catch (err) {
        sendError(reply, err);
      }
    },
  );

  // ── GET /usage/events ─────────────────────────────────────────────────────
  // Raw attribution events — for detailed drill-down.
  app.get<{
    Querystring: { projectId: string; from?: string; to?: string; limit?: string; offset?: string };
  }>(
    '/usage/events',
    async (request, reply) => {
      try {
        const { projectId, from, to, limit: limitStr, offset: offsetStr } = request.query;
        if (!projectId) throw badRequest('projectId is required');

        const limit = Math.min(parseInt(limitStr ?? '50', 10), 200);
        const offset = parseInt(offsetStr ?? '0', 10);
        const supabase = getUserClient(request.accessToken);

        let query = supabase
          .from('attribution_events')
          .select('*', { count: 'exact' })
          .eq('project_id', projectId)
          .order('event_timestamp', { ascending: false })
          .range(offset, offset + limit - 1);

        if (from) query = query.gte('event_timestamp', from);
        if (to) query = query.lte('event_timestamp', to);

        const { data, error, count } = await query;

        if (error) throw internal(error.message);

        const events = ((data ?? []) as AttributionEventRow[]).map((e) => ({
          id: e.id,
          projectId: e.project_id,
          userId: e.user_id,
          file: e.file,
          tool: e.tool,
          confidence: e.confidence,
          detectionMethod: e.detection_method,
          linesStart: e.lines_start,
          linesEnd: e.lines_end,
          charsInserted: e.chars_inserted,
          sessionId: e.session_id,
          accepted: e.accepted,
          timestamp: e.event_timestamp,
          createdAt: e.created_at,
        }));

        return reply.send({ events, total: count ?? 0 });
      } catch (err) {
        sendError(reply, err);
      }
    },
  );
}
