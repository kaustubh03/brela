// ── Email routes ─────────────────────────────────────────────────────────────
// Admin/cron endpoints for email digest management.

import type { FastifyInstance } from 'fastify';
import { requireAuth } from '../auth/middleware.js';
import { sendError, internal } from '../../utils/errors.js';
import { processWeeklyDigests } from './digest.js';
import { getUserClient } from '../../db/client.js';
import type { EmailDigestRow } from '../../db/types.js';

export async function emailRoutes(app: FastifyInstance): Promise<void> {
  // ── POST /emails/digest/trigger ───────────────────────────────────────────
  // Manually trigger the weekly digest processing.
  // In production, this would be called by pg_cron or a scheduled job.
  // Protected — only authenticated users can trigger (add admin check for prod).
  app.post(
    '/emails/digest/trigger',
    { preHandler: [requireAuth] },
    async (_request, reply) => {
      try {
        const result = await processWeeklyDigests();
        return reply.send({
          message: 'Digest processing complete',
          sent: result.sent,
          failed: result.failed,
        });
      } catch (err) {
        sendError(reply, err);
      }
    },
  );

  // ── GET /emails/digests ───────────────────────────────────────────────────
  // List the current user's digest history.
  app.get(
    '/emails/digests',
    { preHandler: [requireAuth] },
    async (request, reply) => {
      try {
        const supabase = getUserClient(request.accessToken);

        const { data, error } = await supabase
          .from('email_digests')
          .select('id, project_id, digest_type, status, sent_at, created_at')
          .eq('user_id', request.userId)
          .order('created_at', { ascending: false })
          .limit(50);

        if (error) throw internal(error.message);

        const digests = ((data ?? []) as EmailDigestRow[]).map((d) => ({
          id: d.id,
          projectId: d.project_id,
          digestType: d.digest_type,
          status: d.status,
          sentAt: d.sent_at,
          createdAt: d.created_at,
        }));

        return reply.send({ digests });
      } catch (err) {
        sendError(reply, err);
      }
    },
  );
}
