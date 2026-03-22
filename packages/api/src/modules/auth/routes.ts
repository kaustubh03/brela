// ── Auth routes ──────────────────────────────────────────────────────────────
// Handles OAuth sign-in (GitHub, Google), token refresh, session info,
// and profile management.

import type { FastifyInstance } from 'fastify';
import { getAnonClient, getUserClient } from '../../db/client.js';
import { requireAuth } from './middleware.js';
import { sendError, badRequest, internal } from '../../utils/errors.js';
import { config } from '../../config.js';
import {
  OAuthSignInBody,
  RefreshBody,
  UpdateProfileBody,
} from './schemas.js';
import type { ProfileRow } from '../../db/types.js';

export async function authRoutes(app: FastifyInstance): Promise<void> {
  // ── POST /auth/signin ────────────────────────────────────────────────────
  // Initiates OAuth flow. Returns the Supabase OAuth URL to redirect to.
  app.post<{ Body: typeof OAuthSignInBody.static }>(
    '/auth/signin',
    { schema: { body: OAuthSignInBody } },
    async (request, reply) => {
      try {
        const { provider, redirectTo } = request.body;
        const supabase = getAnonClient();

        const { data, error } = await supabase.auth.signInWithOAuth({
          provider,
          options: {
            redirectTo: redirectTo ?? `${config.apiUrl}/api/v1/auth/callback`,
            scopes: provider === 'github' ? 'read:user user:email' : undefined,
          },
        });

        if (error || !data.url) {
          throw badRequest(error?.message ?? 'Failed to generate OAuth URL');
        }

        return reply.send({ url: data.url });
      } catch (err) {
        sendError(reply, err);
      }
    },
  );

  // ── GET /auth/callback ───────────────────────────────────────────────────
  // OAuth callback — exchanges the code for a session.
  app.get<{ Querystring: { code?: string; next?: string } }>(
    '/auth/callback',
    async (request, reply) => {
      try {
        const { code, next } = request.query;
        if (!code) throw badRequest('Missing OAuth code');

        const supabase = getAnonClient();
        const { data, error } = await supabase.auth.exchangeCodeForSession(code);

        if (error || !data.session) {
          throw badRequest(error?.message ?? 'Failed to exchange code for session');
        }

        const { session } = data;
        const redirectUrl = new URL(next ?? config.appUrl);
        redirectUrl.searchParams.set('access_token', session.access_token);
        redirectUrl.searchParams.set('refresh_token', session.refresh_token);

        return reply.redirect(redirectUrl.toString());
      } catch (err) {
        sendError(reply, err);
      }
    },
  );

  // ── POST /auth/refresh ──────────────────────────────────────────────────
  // Refreshes an expired access token.
  app.post<{ Body: typeof RefreshBody.static }>(
    '/auth/refresh',
    { schema: { body: RefreshBody } },
    async (request, reply) => {
      try {
        const supabase = getAnonClient();
        const { data, error } = await supabase.auth.refreshSession({
          refresh_token: request.body.refresh_token,
        });

        if (error || !data.session) {
          throw badRequest(error?.message ?? 'Failed to refresh session');
        }

        const { session, user } = data;
        return reply.send({
          user: {
            id: user!.id,
            email: user!.email ?? '',
            fullName: (user!.user_metadata?.['full_name'] as string) ?? null,
            avatarUrl: (user!.user_metadata?.['avatar_url'] as string) ?? null,
            githubUsername: (user!.user_metadata?.['user_name'] as string) ?? null,
          },
          accessToken: session.access_token,
          refreshToken: session.refresh_token,
          expiresAt: session.expires_at ?? 0,
        });
      } catch (err) {
        sendError(reply, err);
      }
    },
  );

  // ── GET /auth/me ─────────────────────────────────────────────────────────
  // Returns the current user's session and profile.
  app.get(
    '/auth/me',
    { preHandler: [requireAuth] },
    async (request, reply) => {
      try {
        const supabase = getUserClient(request.accessToken);
        const { data, error } = await supabase
          .from('profiles')
          .select('*')
          .eq('id', request.userId)
          .single();

        if (error || !data) {
          throw internal('Profile not found');
        }

        const profile = data as ProfileRow;
        return reply.send({
          id: profile.id,
          email: profile.email,
          fullName: profile.full_name,
          avatarUrl: profile.avatar_url,
          githubUsername: profile.github_username,
          emailDigestEnabled: profile.email_digest_enabled,
        });
      } catch (err) {
        sendError(reply, err);
      }
    },
  );

  // ── PATCH /auth/profile ──────────────────────────────────────────────────
  // Updates the current user's profile.
  app.patch<{ Body: typeof UpdateProfileBody.static }>(
    '/auth/profile',
    { preHandler: [requireAuth], schema: { body: UpdateProfileBody } },
    async (request, reply) => {
      try {
        const supabase = getUserClient(request.accessToken);
        const updates: Record<string, unknown> = {};

        if (request.body.fullName !== undefined) updates['full_name'] = request.body.fullName;
        if (request.body.avatarUrl !== undefined) updates['avatar_url'] = request.body.avatarUrl;
        if (request.body.emailDigestEnabled !== undefined) {
          updates['email_digest_enabled'] = request.body.emailDigestEnabled;
        }

        if (Object.keys(updates).length === 0) {
          throw badRequest('No fields to update');
        }

        const { data, error } = await supabase
          .from('profiles')
          .update(updates)
          .eq('id', request.userId)
          .select()
          .single();

        if (error) throw internal(error.message);

        const profile = data as ProfileRow;
        return reply.send({
          id: profile.id,
          email: profile.email,
          fullName: profile.full_name,
          avatarUrl: profile.avatar_url,
          githubUsername: profile.github_username,
          emailDigestEnabled: profile.email_digest_enabled,
        });
      } catch (err) {
        sendError(reply, err);
      }
    },
  );

  // ── POST /auth/signout ──────────────────────────────────────────────────
  app.post(
    '/auth/signout',
    { preHandler: [requireAuth] },
    async (request, reply) => {
      try {
        const supabase = getAnonClient();
        await supabase.auth.admin.signOut(request.accessToken);
        return reply.status(204).send();
      } catch (err) {
        sendError(reply, err);
      }
    },
  );
}
