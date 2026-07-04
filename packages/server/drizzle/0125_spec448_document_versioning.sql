-- spec-448 t-1: the database primitives for document versioning.
--
-- The repo applies numbered hand-migrations via apply-hand-migrations.mjs (the
-- drizzle journal only owns up to 0008), so a new numbered .sql is the correct
-- pattern — mirrors 0009-0124.
--
-- WHAT THIS ADDS
--   1. documents.version — the doc's current version number (starts at 1).
--   2. document_versions — an immutable, content-addressed snapshot of a Spec's
--      full artifact graph (sections + decisions + acs + tasks + issues +
--      comments), cut at a point in time. Memex-scoped tenant table (std-36):
--      ENABLE + NO FORCE row-level security with the standard
--      `document_versions_memex_isolation` policy (spec-257 dec-1 / migration
--      0093 posture — the runtime `memex_app` role stays subject to RLS; the
--      `postgres` owner role used by migrations/deploys bypasses it).
--      IMMUTABLE BY CONVENTION: no UPDATE trigger is added — the service layer
--      simply never exposes an update path (mirrors facet_routing_log's
--      append-only posture, migration 0115).
--   3. doc_views — a per-user read-state marker (last version of a doc a user
--      has viewed). NO memex_id (keyed purely on user_id + doc_id), so it does
--      NOT join the memex_isolation family. Instead it carries its own
--      exclusive `doc_views_owner_isolation` policy scoped on `app.user_id`
--      (the GUC spec-303's runWithUserId already sets, migration 0098) — a
--      user can only ever read/write their OWN marker row. This is a new RLS
--      shape: qa_report_views (the closest existing per-user table, migration
--      0092/0098) scopes by memex_id and leaves per-user scoping to the
--      service layer; doc_views is the first table whose RLS predicate is
--      user-exclusive at the database level.
--   4. retired_at_version — nullable, added to doc_sections / decisions / acs /
--      tasks / issues / doc_comments. Marks an artifact left behind at a
--      version cut, alongside each table's existing soft-delete lifecycle.
--
-- Named UNIQUE / CHECK / index/ policy names match the Drizzle schema's
-- unique()/index()/check() names so introspection-by-conname stays in
-- lockstep. Idempotent (IF NOT EXISTS / DROP POLICY IF EXISTS) so the
-- hand-migration runner re-applies cleanly.
--
-- std-39 (database hygiene) review:
--   cl-2/cl-3 (lock order + bounded wait) — §1 and §4 below run seven plain
--   `ADD COLUMN` statements against tables the app writes continuously
--   (documents, doc_sections, decisions, acs, tasks, issues, doc_comments).
--   Every one is a NOT-NULL-with-constant-default or a bare-nullable add,
--   which Postgres 11+ performs as a metadata-only change (no table rewrite,
--   no ACCESS EXCLUSIVE held for longer than the catalog update) — not the
--   spec-398 class of heavy operation. `lock_timeout` is still set below so a
--   coincident long-running transaction on one of these tables makes the
--   migration fail fast and retry on the next deploy, rather than blocking
--   live writers.
--   cl-4 (growth) — document_versions accrues one row per EXPLICIT user
--   version-cut (not per request/event), so its growth profile is bounded by
--   deliberate human action rather than automatic traffic — the same shape as
--   `documents` itself, which carries no retention cap either. No age/count
--   cap is added; this is a considered choice, not a silent gap.
--   cl-7/cl-27 (hot-write small table) — doc_views is exactly the "last-seen
--   timestamp" example the clause names. Its write RATE (throttling / upsert
--   frequency on doc opens) is a service-layer decision that belongs to t-5
--   (Last-seen tracking), not this schema-only task; flagged here so t-5
--   weighs it before wiring the write path.
SET lock_timeout = '5s';
--> statement-breakpoint

-- 1. documents.version -----------------------------------------------------
ALTER TABLE documents ADD COLUMN IF NOT EXISTS version integer NOT NULL DEFAULT 1;

-- 2. document_versions ------------------------------------------------------
CREATE TABLE IF NOT EXISTS document_versions (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  memex_id               UUID NOT NULL,
  doc_id                 UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  version_number         INTEGER NOT NULL,
  name                   TEXT NOT NULL,
  checksum               TEXT NOT NULL,
  snapshot               JSONB NOT NULL,
  restored_from_version  INTEGER,
  actor_user_id          UUID REFERENCES users(id) ON DELETE SET NULL,
  actor_name             TEXT,
  channel                TEXT,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT document_versions_doc_id_version_number_unique UNIQUE (doc_id, version_number),
  CONSTRAINT document_versions_channel_valid
    CHECK (channel IN ('rest_ui', 'mcp', 'in_app_agent', 'server'))
);

CREATE INDEX IF NOT EXISTS document_versions_memex_id_idx ON document_versions (memex_id);
CREATE INDEX IF NOT EXISTS document_versions_doc_id_idx ON document_versions (doc_id);

-- Tenancy (std-36): direct memex_id, so the memex_isolation policy applies.
-- ENABLED but NOT FORCED (spec-257 dec-1, migration 0093) — FORCE bites the
-- owner role `postgres` used by migrations/deploys; NO FORCE lets the owner
-- bypass while the runtime role memex_app stays subject to RLS.
ALTER TABLE document_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE document_versions NO FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS document_versions_memex_isolation ON document_versions;
CREATE POLICY document_versions_memex_isolation ON document_versions
  USING (
    nullif(current_setting('app.memex_id', true), '') IS NOT NULL
    AND memex_id = current_setting('app.memex_id', true)::uuid
  )
  WITH CHECK (
    nullif(current_setting('app.memex_id', true), '') IS NOT NULL
    AND memex_id = current_setting('app.memex_id', true)::uuid
  );

GRANT SELECT, INSERT, UPDATE, DELETE ON document_versions TO memex_app;

-- 3. doc_views ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS doc_views (
  user_id             UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  doc_id              UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  last_viewed_version INTEGER NOT NULL,
  last_viewed_at      TIMESTAMPTZ NOT NULL,
  channel             TEXT NOT NULL,
  CONSTRAINT doc_views_pkey PRIMARY KEY (user_id, doc_id),
  CONSTRAINT doc_views_channel_valid
    CHECK (channel IN ('rest_ui', 'mcp', 'in_app_agent', 'server'))
);

-- Own-row-only RLS: no memex_id on this table, so it is intentionally NOT part
-- of the memex_isolation family / RLS_TENANT_TABLES set. Scoped exclusively on
-- app.user_id (set by runWithUserId, migration 0098) so a user can only ever
-- see/touch their own marker. ENABLE + NO FORCE (std-36; the owner role used
-- by migrations/deploys must still be able to read/write freely).
ALTER TABLE doc_views ENABLE ROW LEVEL SECURITY;
ALTER TABLE doc_views NO FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS doc_views_owner_isolation ON doc_views;
CREATE POLICY doc_views_owner_isolation ON doc_views
  USING (
    nullif(current_setting('app.user_id', true), '') IS NOT NULL
    AND user_id = current_setting('app.user_id', true)::uuid
  )
  WITH CHECK (
    nullif(current_setting('app.user_id', true), '') IS NOT NULL
    AND user_id = current_setting('app.user_id', true)::uuid
  );

GRANT SELECT, INSERT, UPDATE, DELETE ON doc_views TO memex_app;

-- 4. retired_at_version -------------------------------------------------------
ALTER TABLE doc_sections ADD COLUMN IF NOT EXISTS retired_at_version integer;
ALTER TABLE decisions    ADD COLUMN IF NOT EXISTS retired_at_version integer;
ALTER TABLE acs          ADD COLUMN IF NOT EXISTS retired_at_version integer;
ALTER TABLE tasks        ADD COLUMN IF NOT EXISTS retired_at_version integer;
ALTER TABLE issues       ADD COLUMN IF NOT EXISTS retired_at_version integer;
ALTER TABLE doc_comments ADD COLUMN IF NOT EXISTS retired_at_version integer;
