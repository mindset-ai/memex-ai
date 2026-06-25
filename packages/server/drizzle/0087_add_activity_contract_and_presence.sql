-- spec-122 t-1 (dec-2 / dec-4 / dec-5) — the activity contract + the presence plane.
--
-- Two moves:
--   1. Add the activity-contract columns (actor_user_id, actor_name, channel) to
--      every activity-bearing source table that lacks them — acs, tasks,
--      decisions, doc_sections — plus channel to doc_comments (which already
--      carries author_user_id / author_name). These are what let the activity
--      view (dec-1, t-6) project one uniform {WHEN, WHO, HOW, WHAT} shape across
--      every UNION arm. actor_name is denormalised so a later user rename/delete
--      can't rewrite historical attribution (ac-10). All NULLABLE — backfill-free:
--      unknown on legacy rows and on any write that doesn't (yet) thread ctx
--      (dec-5, "WHO is correct going forward only").
--   2. Create the ephemeral `presence` plane (dec-4) — who's here now, decaying.
--
-- NO phase_transitions table (dec-3 — phase history rides spec-179's status_changed
-- activity_log rows) and NO user_identities table (dec-8 — the WHO resolver reuses
-- users.email / users.name / mcp_sessions.client_name). activity_log and its sweep
-- are RETAINED (dec-1), untouched here.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS for columns (the inline FK rides the column,
-- so it isn't re-added); CHECK constraints guarded by a pg_constraint probe;
-- CREATE TABLE / INDEX IF NOT EXISTS for presence. The runner wraps the file in a
-- single transaction tracked in manual_migrations.

-- ── 1. Activity-contract columns on the source tables ────────────────────────

ALTER TABLE acs
  ADD COLUMN IF NOT EXISTS actor_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS actor_name    text,
  ADD COLUMN IF NOT EXISTS channel       text;

ALTER TABLE tasks
  ADD COLUMN IF NOT EXISTS actor_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS actor_name    text,
  ADD COLUMN IF NOT EXISTS channel       text;

ALTER TABLE decisions
  ADD COLUMN IF NOT EXISTS actor_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS actor_name    text,
  ADD COLUMN IF NOT EXISTS channel       text;

ALTER TABLE doc_sections
  ADD COLUMN IF NOT EXISTS actor_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS actor_name    text,
  ADD COLUMN IF NOT EXISTS channel       text;

ALTER TABLE doc_comments
  ADD COLUMN IF NOT EXISTS channel       text;

-- channel vocabulary CHECKs (NULL passes — a CHECK is satisfied when its predicate
-- is NULL — so legacy / unthreaded writes are allowed while stamped values are
-- constrained to the contract's four surfaces).
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['acs','tasks','decisions','doc_sections','doc_comments'] LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint WHERE conname = t || '_channel_valid'
    ) THEN
      EXECUTE format(
        'ALTER TABLE %I ADD CONSTRAINT %I CHECK (channel IN (''rest_ui'',''mcp'',''in_app_agent'',''server''))',
        t, t || '_channel_valid'
      );
    END IF;
  END LOOP;
END $$;

-- ── 2. The presence plane (ephemeral, decaying) ──────────────────────────────

CREATE TABLE IF NOT EXISTS presence (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  memex_id        uuid NOT NULL REFERENCES memexes(id)   ON DELETE CASCADE,
  doc_id          uuid NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  actor_user_id   uuid NOT NULL REFERENCES users(id)     ON DELETE CASCADE,
  actor_name      text,
  actor_kind      text NOT NULL,
  channel         text NOT NULL,
  client_id       text NOT NULL DEFAULT '',
  last_seen_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT presence_doc_actor_channel_client_unique
    UNIQUE (doc_id, actor_user_id, channel, client_id),
  CONSTRAINT presence_actor_kind_valid
    CHECK (actor_kind IN ('human', 'mcp_agent', 'in_app_agent', 'system')),
  CONSTRAINT presence_channel_valid
    CHECK (channel IN ('rest_ui', 'mcp', 'in_app_agent', 'server'))
);

CREATE INDEX IF NOT EXISTS presence_doc_id_last_seen_at_idx
  ON presence (doc_id, last_seen_at);
CREATE INDEX IF NOT EXISTS presence_memex_id_last_seen_at_idx
  ON presence (memex_id, last_seen_at);

-- ── Row Level Security (spec-199 t-12 pattern) ───────────────────────────────
-- `presence` is a primary tenant table (direct memex_id NOT NULL), so it gets
-- the same ENABLE + FORCE RLS + app.memex_id isolation policy every other
-- tenant table carries (drizzle/0081). Tenant isolation is a DB-level invariant,
-- not an app/UI filter: the restricted runtime role `memex_app` is bound by the
-- policy on every read AND write; the superuser (`postgres`, used by migrations,
-- local dev, and the test suite) bypasses it. The presence write path
-- (markPresent, routes/presence.ts) and read paths (listPresent[ForMemex]) all
-- run under session middleware, which sets the app.memex_id GUC via
-- runWithMemexId — so WITH CHECK passes on inserts and USING scopes reads.
-- The memex_app SELECT/INSERT/UPDATE/DELETE grant is inherited from the
-- ALTER DEFAULT PRIVILEGES set in 0081 (presence is created after it).
ALTER TABLE presence ENABLE ROW LEVEL SECURITY;
ALTER TABLE presence FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS presence_memex_isolation ON presence;
CREATE POLICY presence_memex_isolation ON presence
  USING (
    nullif(current_setting('app.memex_id', true), '') IS NOT NULL
    AND memex_id = current_setting('app.memex_id', true)::uuid
  )
  WITH CHECK (
    nullif(current_setting('app.memex_id', true), '') IS NOT NULL
    AND memex_id = current_setting('app.memex_id', true)::uuid
  );
