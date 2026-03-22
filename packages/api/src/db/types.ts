// ── Database Row Types ────────────────────────────────────────────────────────
// Explicit row types for Supabase query results.
// In production, generate these with `npx supabase gen types typescript`.

export interface ProfileRow {
  id: string;
  email: string;
  full_name: string | null;
  avatar_url: string | null;
  github_username: string | null;
  google_id: string | null;
  email_digest_enabled: boolean;
  created_at: string;
  updated_at: string;
}

export interface ProjectRow {
  id: string;
  name: string;
  repo_url: string | null;
  owner_id: string;
  created_at: string;
  updated_at: string;
}

export interface ProjectMemberRow {
  project_id: string;
  user_id: string;
  role: 'owner' | 'admin' | 'member';
  joined_at: string;
}

export interface ReportRow {
  id: string;
  project_id: string;
  created_by: string;
  days_analysed: number;
  date_from: string;
  date_to: string;
  ai_percentage: number;
  total_ai_lines: number;
  total_human_lines: number;
  metrics: Record<string, unknown>;
  created_at: string;
}

export interface AttributionEventRow {
  id: string;
  project_id: string;
  user_id: string;
  file: string;
  tool: string;
  confidence: 'high' | 'medium' | 'low';
  detection_method: string;
  lines_start: number;
  lines_end: number;
  chars_inserted: number;
  session_id: string;
  accepted: boolean;
  event_timestamp: string;
  created_at: string;
}

export interface UsageSummaryRow {
  id: string;
  project_id: string;
  user_id: string;
  date: string;
  tool: string;
  total_lines: number;
  total_chars: number;
  event_count: number;
  created_at: string;
}

export interface EmailDigestRow {
  id: string;
  user_id: string;
  project_id: string;
  digest_type: 'weekly' | 'monthly';
  status: 'pending' | 'sent' | 'failed';
  report_snapshot: Record<string, unknown> | null;
  sent_at: string | null;
  created_at: string;
}
