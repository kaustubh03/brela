-- ============================================================================
-- Brela API — Database Schema (Supabase / Postgres)
-- ============================================================================
-- Run this in the Supabase SQL Editor or via a migration.
-- Assumes Supabase Auth is already provisioned (auth.users exists).
-- ============================================================================

-- ── Custom ENUM types ────────────────────────────────────────────────────────

CREATE TYPE member_role     AS ENUM ('owner', 'admin', 'member');
CREATE TYPE digest_type     AS ENUM ('weekly', 'monthly');
CREATE TYPE digest_status   AS ENUM ('pending', 'sent', 'failed');
CREATE TYPE confidence_level AS ENUM ('high', 'medium', 'low');

-- ── Profiles ─────────────────────────────────────────────────────────────────
-- Extended user data linked to Supabase auth.users via id.

CREATE TABLE profiles (
  id                   UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email                TEXT        NOT NULL,
  full_name            TEXT,
  avatar_url           TEXT,
  github_username      TEXT        UNIQUE,
  google_id            TEXT        UNIQUE,
  email_digest_enabled BOOLEAN     NOT NULL DEFAULT true,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Auto-create a profile row when a new user signs up via Supabase Auth.
CREATE OR REPLACE FUNCTION handle_new_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
  INSERT INTO public.profiles (id, email, full_name, avatar_url, github_username)
  VALUES (
    NEW.id,
    NEW.email,
    NEW.raw_user_meta_data ->> 'full_name',
    NEW.raw_user_meta_data ->> 'avatar_url',
    NEW.raw_user_meta_data ->> 'user_name'   -- GitHub provider populates this
  );
  RETURN NEW;
END;
$$;

CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION handle_new_user();

-- RLS
ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can read own profile"
  ON profiles FOR SELECT
  USING (auth.uid() = id);

CREATE POLICY "Users can update own profile"
  ON profiles FOR UPDATE
  USING (auth.uid() = id);


-- ── Projects ─────────────────────────────────────────────────────────────────

CREATE TABLE projects (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name       TEXT        NOT NULL,
  repo_url   TEXT,
  owner_id   UUID        NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE projects ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Project members can read projects"
  ON projects FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM project_members pm
      WHERE pm.project_id = projects.id AND pm.user_id = auth.uid()
    )
  );

CREATE POLICY "Owner can update project"
  ON projects FOR UPDATE
  USING (owner_id = auth.uid());

CREATE POLICY "Authenticated users can create projects"
  ON projects FOR INSERT
  WITH CHECK (owner_id = auth.uid());


-- ── Project Members ──────────────────────────────────────────────────────────

CREATE TABLE project_members (
  project_id UUID        NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id    UUID        NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  role       member_role NOT NULL DEFAULT 'member',
  joined_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, user_id)
);

ALTER TABLE project_members ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Members can read memberships"
  ON project_members FOR SELECT
  USING (user_id = auth.uid());

CREATE POLICY "Owners/admins can manage members"
  ON project_members FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM project_members pm2
      WHERE pm2.project_id = project_members.project_id
        AND pm2.user_id = auth.uid()
        AND pm2.role IN ('owner', 'admin')
    )
  );


-- ── Reports ──────────────────────────────────────────────────────────────────
-- Each row is a snapshot of a brela report (full ReportMetrics stored as JSONB).

CREATE TABLE reports (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id       UUID        NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  created_by       UUID        NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  days_analysed    INT         NOT NULL,
  date_from        DATE        NOT NULL,
  date_to          DATE        NOT NULL,
  ai_percentage    REAL        NOT NULL DEFAULT 0,
  total_ai_lines   INT         NOT NULL DEFAULT 0,
  total_human_lines INT        NOT NULL DEFAULT 0,
  metrics          JSONB       NOT NULL DEFAULT '{}',
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_reports_project ON reports(project_id, created_at DESC);

ALTER TABLE reports ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Project members can read reports"
  ON reports FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM project_members pm
      WHERE pm.project_id = reports.project_id AND pm.user_id = auth.uid()
    )
  );

CREATE POLICY "Project members can create reports"
  ON reports FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM project_members pm
      WHERE pm.project_id = reports.project_id AND pm.user_id = auth.uid()
    )
  );


-- ── Attribution Events ───────────────────────────────────────────────────────
-- Raw AI attribution entries ingested from the CLI or daemon.

CREATE TABLE attribution_events (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id       UUID             NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id          UUID             NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  file             TEXT             NOT NULL,
  tool             TEXT             NOT NULL,
  confidence       confidence_level NOT NULL DEFAULT 'medium',
  detection_method TEXT             NOT NULL,
  lines_start      INT              NOT NULL DEFAULT 0,
  lines_end        INT              NOT NULL DEFAULT 0,
  chars_inserted   INT              NOT NULL DEFAULT 0,
  session_id       TEXT             NOT NULL,
  accepted         BOOLEAN          NOT NULL DEFAULT true,
  event_timestamp  TIMESTAMPTZ      NOT NULL,
  created_at       TIMESTAMPTZ      NOT NULL DEFAULT now()
);

CREATE INDEX idx_attribution_project_ts
  ON attribution_events(project_id, event_timestamp DESC);

CREATE INDEX idx_attribution_user
  ON attribution_events(user_id, event_timestamp DESC);

ALTER TABLE attribution_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Project members can read events"
  ON attribution_events FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM project_members pm
      WHERE pm.project_id = attribution_events.project_id AND pm.user_id = auth.uid()
    )
  );

CREATE POLICY "Project members can insert events"
  ON attribution_events FOR INSERT
  WITH CHECK (
    user_id = auth.uid()
    AND EXISTS (
      SELECT 1 FROM project_members pm
      WHERE pm.project_id = attribution_events.project_id AND pm.user_id = auth.uid()
    )
  );


-- ── Usage Summaries ──────────────────────────────────────────────────────────
-- Pre-aggregated daily stats (materialised by a pg_cron job).

CREATE TABLE usage_summaries (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id   UUID        NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id      UUID        NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  date         DATE        NOT NULL,
  tool         TEXT        NOT NULL,
  total_lines  INT         NOT NULL DEFAULT 0,
  total_chars  INT         NOT NULL DEFAULT 0,
  event_count  INT         NOT NULL DEFAULT 0,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (project_id, user_id, date, tool)
);

CREATE INDEX idx_usage_project_date ON usage_summaries(project_id, date DESC);

ALTER TABLE usage_summaries ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Members can read usage summaries"
  ON usage_summaries FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM project_members pm
      WHERE pm.project_id = usage_summaries.project_id AND pm.user_id = auth.uid()
    )
  );


-- ── Email Digests ────────────────────────────────────────────────────────────

CREATE TABLE email_digests (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          UUID          NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  project_id       UUID          NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  digest_type      digest_type   NOT NULL DEFAULT 'weekly',
  status           digest_status NOT NULL DEFAULT 'pending',
  report_snapshot  JSONB,
  sent_at          TIMESTAMPTZ,
  created_at       TIMESTAMPTZ   NOT NULL DEFAULT now()
);

CREATE INDEX idx_digests_pending ON email_digests(status) WHERE status = 'pending';

ALTER TABLE email_digests ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can read own digests"
  ON email_digests FOR SELECT
  USING (user_id = auth.uid());


-- ── pg_cron: Weekly usage aggregation ────────────────────────────────────────
-- Requires the pg_cron extension (enabled in Supabase dashboard → Extensions).
-- Runs every Sunday at 02:00 UTC.

-- SELECT cron.schedule(
--   'aggregate-weekly-usage',
--   '0 2 * * 0',
--   $$
--     INSERT INTO usage_summaries (project_id, user_id, date, tool, total_lines, total_chars, event_count)
--     SELECT
--       project_id,
--       user_id,
--       event_timestamp::date AS date,
--       tool,
--       SUM(lines_end - lines_start)  AS total_lines,
--       SUM(chars_inserted)            AS total_chars,
--       COUNT(*)                       AS event_count
--     FROM attribution_events
--     WHERE event_timestamp >= now() - INTERVAL '7 days'
--     GROUP BY project_id, user_id, date, tool
--     ON CONFLICT (project_id, user_id, date, tool) DO UPDATE SET
--       total_lines = EXCLUDED.total_lines,
--       total_chars = EXCLUDED.total_chars,
--       event_count = EXCLUDED.event_count;
--   $$
-- );

-- ── pg_cron: Weekly digest email queue ───────────────────────────────────────
-- Runs every Monday at 09:00 UTC. Creates pending digest entries
-- for all users who have email_digest_enabled = true.

-- SELECT cron.schedule(
--   'queue-weekly-digests',
--   '0 9 * * 1',
--   $$
--     INSERT INTO email_digests (user_id, project_id, digest_type, status)
--     SELECT p.id, pm.project_id, 'weekly', 'pending'
--     FROM profiles p
--     JOIN project_members pm ON pm.user_id = p.id
--     WHERE p.email_digest_enabled = true;
--   $$
-- );

-- ── updated_at trigger ───────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER set_profiles_updated_at
  BEFORE UPDATE ON profiles
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER set_projects_updated_at
  BEFORE UPDATE ON projects
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();
