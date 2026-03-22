// ── Supabase client singletons ────────────────────────────────────────────────
// Two clients: one with the anon key (respects RLS), one with the service role
// key (bypasses RLS for server-side operations like cron jobs and admin tasks).

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { config } from '../config.js';

let _anonClient: SupabaseClient | null = null;
let _serviceClient: SupabaseClient | null = null;

/**
 * Public client — uses the anon key.
 * All queries go through Postgres RLS policies.
 * Use this for user-facing requests.
 */
export function getAnonClient(): SupabaseClient {
  if (!_anonClient) {
    _anonClient = createClient(config.supabase.url, config.supabase.anonKey, {
      auth: { autoRefreshToken: false, persistSession: false, flowType: 'pkce' },
    });
  }
  return _anonClient;
}

/**
 * Service-role client — bypasses RLS.
 * Use this for internal operations: cron jobs, email digests, admin tasks.
 * NEVER expose this client to user requests.
 */
export function getServiceClient(): SupabaseClient {
  if (!_serviceClient) {
    _serviceClient = createClient(
      config.supabase.url,
      config.supabase.serviceRoleKey,
      { auth: { autoRefreshToken: false, persistSession: false } },
    );
  }
  return _serviceClient;
}

/**
 * Create a per-request client scoped to a user's JWT.
 * This ensures RLS evaluates against the correct `auth.uid()`.
 */
export function getUserClient(accessToken: string): SupabaseClient {
  return createClient(config.supabase.url, config.supabase.anonKey, {
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
    auth: { autoRefreshToken: false, persistSession: false },
  });
}
