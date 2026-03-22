// ── Auth middleware — JWT verification via Supabase ───────────────────────────

import type { FastifyRequest, FastifyReply } from 'fastify';
import { getAnonClient } from '../../db/client.js';
import { unauthorized } from '../../utils/errors.js';

/**
 * Extracts the Bearer token from the Authorization header
 * and verifies it against Supabase Auth.
 *
 * On success, attaches `request.userId` and `request.accessToken`.
 * On failure, returns 401.
 */
export async function requireAuth(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const authHeader = request.headers.authorization;

  if (!authHeader?.startsWith('Bearer ')) {
    const err = unauthorized('Missing or malformed Authorization header');
    reply.status(err.statusCode).send(err.toJSON());
    return;
  }

  const token = authHeader.slice(7);
  const supabase = getAnonClient();

  const { data, error } = await supabase.auth.getUser(token);

  if (error || !data.user) {
    const err = unauthorized('Invalid or expired token');
    reply.status(err.statusCode).send(err.toJSON());
    return;
  }

  // Attach user info to the request for downstream handlers
  request.userId = data.user.id;
  request.accessToken = token;
}

// ── Fastify type augmentation ────────────────────────────────────────────────

declare module 'fastify' {
  interface FastifyRequest {
    userId: string;
    accessToken: string;
  }
}
