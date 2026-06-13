-- spec-199 t-12: Row Level Security — Phase 2 tenant table policies
--
-- ⚠️ SUPERSEDED IN PART by migration 0093 (spec-257 dec-1 / std-36): the FORCE
-- below was the bug. On Cloud SQL `postgres` is NOT a real superuser and has no
-- BYPASSRLS, so FORCE filtered the deploy/migration role to zero rows (the
-- 2026-06-10 emission + 2026-06-11 What's New outages). 0093 drops FORCE on all
-- these tables; the header text below ("superuser postgres bypasses RLS
-- unconditionally") is FALSE on Cloud SQL — kept only as the historical record.
--
-- Enables ENABLE + FORCE ROW LEVEL SECURITY on every primary tenant table
-- (tables with a direct `memex_id NOT NULL` column). Each policy enforces
-- that the `app.memex_id` GUC is set AND matches the row's memex_id. The
-- runtime role `memex_app` (non-superuser, no BYPASSRLS) is subject to all
-- policies; the superuser `postgres` bypasses RLS unconditionally.
--
-- Policy semantics:
--   USING     — filters SELECT, UPDATE, DELETE
--   WITH CHECK — validates INSERT and UPDATE values
--   nullif(..., '') guards against an empty-string GUC reaching ::uuid cast
--
-- Roles:
--   postgres    — superuser (BYPASSRLS), used for migrations + local dev
--   memex_app   — restricted runtime role for Cloud Run; subject to policies
--
-- Excluded tables and why (deferred to 0082):
--   user_memex_access — queried in publicSessionMiddleware before ALS sets
--                       memex_id; adding a standard policy breaks session
--                       establishment with 0 rows.
--   doc_sections      — no direct memex_id column; requires a join policy
--                       (EXISTS subquery via doc_id → documents.memex_id).
--   conversations     — no direct memex_id; requires join via doc_id → documents.
--   messages          — no direct memex_id; requires join via conversation_id.
--   activity_log      — background bus relay (spec-156 LISTEN handler) calls
--                       persistEvent without request ALS context; WITH CHECK
--                       would silently reject those INSERTs. Needs relay to gain
--                       runWithMemexId before policies can be applied safely.
--   mcp_tool_calls    — nullable memex_id; needs a nullable-safe policy variant.

-- ── memex_app runtime role ─────────────────────────────────────────────────────

DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'memex_app') THEN
    CREATE ROLE memex_app;
  END IF;
END
$$;

GRANT USAGE ON SCHEMA public TO memex_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO memex_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO memex_app;

ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO memex_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO memex_app;

-- ── documents ──────────────────────────────────────────────────────────────────

ALTER TABLE documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE documents FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS documents_memex_isolation ON documents;
CREATE POLICY documents_memex_isolation ON documents
  USING (
    nullif(current_setting('app.memex_id', true), '') IS NOT NULL
    AND memex_id = current_setting('app.memex_id', true)::uuid
  )
  WITH CHECK (
    nullif(current_setting('app.memex_id', true), '') IS NOT NULL
    AND memex_id = current_setting('app.memex_id', true)::uuid
  );

-- ── standard_clauses ──────────────────────────────────────────────────────────

ALTER TABLE standard_clauses ENABLE ROW LEVEL SECURITY;
ALTER TABLE standard_clauses FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS standard_clauses_memex_isolation ON standard_clauses;
CREATE POLICY standard_clauses_memex_isolation ON standard_clauses
  USING (
    nullif(current_setting('app.memex_id', true), '') IS NOT NULL
    AND memex_id = current_setting('app.memex_id', true)::uuid
  )
  WITH CHECK (
    nullif(current_setting('app.memex_id', true), '') IS NOT NULL
    AND memex_id = current_setting('app.memex_id', true)::uuid
  );

-- ── clause_refs ────────────────────────────────────────────────────────────────

ALTER TABLE clause_refs ENABLE ROW LEVEL SECURITY;
ALTER TABLE clause_refs FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS clause_refs_memex_isolation ON clause_refs;
CREATE POLICY clause_refs_memex_isolation ON clause_refs
  USING (
    nullif(current_setting('app.memex_id', true), '') IS NOT NULL
    AND memex_id = current_setting('app.memex_id', true)::uuid
  )
  WITH CHECK (
    nullif(current_setting('app.memex_id', true), '') IS NOT NULL
    AND memex_id = current_setting('app.memex_id', true)::uuid
  );

-- ── doc_comments ──────────────────────────────────────────────────────────────

ALTER TABLE doc_comments ENABLE ROW LEVEL SECURITY;
ALTER TABLE doc_comments FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS doc_comments_memex_isolation ON doc_comments;
CREATE POLICY doc_comments_memex_isolation ON doc_comments
  USING (
    nullif(current_setting('app.memex_id', true), '') IS NOT NULL
    AND memex_id = current_setting('app.memex_id', true)::uuid
  )
  WITH CHECK (
    nullif(current_setting('app.memex_id', true), '') IS NOT NULL
    AND memex_id = current_setting('app.memex_id', true)::uuid
  );

-- ── decisions ─────────────────────────────────────────────────────────────────

ALTER TABLE decisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE decisions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS decisions_memex_isolation ON decisions;
CREATE POLICY decisions_memex_isolation ON decisions
  USING (
    nullif(current_setting('app.memex_id', true), '') IS NOT NULL
    AND memex_id = current_setting('app.memex_id', true)::uuid
  )
  WITH CHECK (
    nullif(current_setting('app.memex_id', true), '') IS NOT NULL
    AND memex_id = current_setting('app.memex_id', true)::uuid
  );

-- ── tasks ─────────────────────────────────────────────────────────────────────

ALTER TABLE tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE tasks FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tasks_memex_isolation ON tasks;
CREATE POLICY tasks_memex_isolation ON tasks
  USING (
    nullif(current_setting('app.memex_id', true), '') IS NOT NULL
    AND memex_id = current_setting('app.memex_id', true)::uuid
  )
  WITH CHECK (
    nullif(current_setting('app.memex_id', true), '') IS NOT NULL
    AND memex_id = current_setting('app.memex_id', true)::uuid
  );

-- ── acs ───────────────────────────────────────────────────────────────────────

ALTER TABLE acs ENABLE ROW LEVEL SECURITY;
ALTER TABLE acs FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS acs_memex_isolation ON acs;
CREATE POLICY acs_memex_isolation ON acs
  USING (
    nullif(current_setting('app.memex_id', true), '') IS NOT NULL
    AND memex_id = current_setting('app.memex_id', true)::uuid
  )
  WITH CHECK (
    nullif(current_setting('app.memex_id', true), '') IS NOT NULL
    AND memex_id = current_setting('app.memex_id', true)::uuid
  );

-- ── issues ────────────────────────────────────────────────────────────────────

ALTER TABLE issues ENABLE ROW LEVEL SECURITY;
ALTER TABLE issues FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS issues_memex_isolation ON issues;
CREATE POLICY issues_memex_isolation ON issues
  USING (
    nullif(current_setting('app.memex_id', true), '') IS NOT NULL
    AND memex_id = current_setting('app.memex_id', true)::uuid
  )
  WITH CHECK (
    nullif(current_setting('app.memex_id', true), '') IS NOT NULL
    AND memex_id = current_setting('app.memex_id', true)::uuid
  );

-- ── doc_members ───────────────────────────────────────────────────────────────

ALTER TABLE doc_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE doc_members FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS doc_members_memex_isolation ON doc_members;
CREATE POLICY doc_members_memex_isolation ON doc_members
  USING (
    nullif(current_setting('app.memex_id', true), '') IS NOT NULL
    AND memex_id = current_setting('app.memex_id', true)::uuid
  )
  WITH CHECK (
    nullif(current_setting('app.memex_id', true), '') IS NOT NULL
    AND memex_id = current_setting('app.memex_id', true)::uuid
  );

-- ── doc_assignees ─────────────────────────────────────────────────────────────

ALTER TABLE doc_assignees ENABLE ROW LEVEL SECURITY;
ALTER TABLE doc_assignees FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS doc_assignees_memex_isolation ON doc_assignees;
CREATE POLICY doc_assignees_memex_isolation ON doc_assignees
  USING (
    nullif(current_setting('app.memex_id', true), '') IS NOT NULL
    AND memex_id = current_setting('app.memex_id', true)::uuid
  )
  WITH CHECK (
    nullif(current_setting('app.memex_id', true), '') IS NOT NULL
    AND memex_id = current_setting('app.memex_id', true)::uuid
  );

-- ── tags ──────────────────────────────────────────────────────────────────────

ALTER TABLE tags ENABLE ROW LEVEL SECURITY;
ALTER TABLE tags FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tags_memex_isolation ON tags;
CREATE POLICY tags_memex_isolation ON tags
  USING (
    nullif(current_setting('app.memex_id', true), '') IS NOT NULL
    AND memex_id = current_setting('app.memex_id', true)::uuid
  )
  WITH CHECK (
    nullif(current_setting('app.memex_id', true), '') IS NOT NULL
    AND memex_id = current_setting('app.memex_id', true)::uuid
  );

-- ── document_tags ─────────────────────────────────────────────────────────────

ALTER TABLE document_tags ENABLE ROW LEVEL SECURITY;
ALTER TABLE document_tags FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS document_tags_memex_isolation ON document_tags;
CREATE POLICY document_tags_memex_isolation ON document_tags
  USING (
    nullif(current_setting('app.memex_id', true), '') IS NOT NULL
    AND memex_id = current_setting('app.memex_id', true)::uuid
  )
  WITH CHECK (
    nullif(current_setting('app.memex_id', true), '') IS NOT NULL
    AND memex_id = current_setting('app.memex_id', true)::uuid
  );

-- ── memex_emission_keys ───────────────────────────────────────────────────────

ALTER TABLE memex_emission_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE memex_emission_keys FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS memex_emission_keys_memex_isolation ON memex_emission_keys;
CREATE POLICY memex_emission_keys_memex_isolation ON memex_emission_keys
  USING (
    nullif(current_setting('app.memex_id', true), '') IS NOT NULL
    AND memex_id = current_setting('app.memex_id', true)::uuid
  )
  WITH CHECK (
    nullif(current_setting('app.memex_id', true), '') IS NOT NULL
    AND memex_id = current_setting('app.memex_id', true)::uuid
  );

-- ── repos ─────────────────────────────────────────────────────────────────────

ALTER TABLE repos ENABLE ROW LEVEL SECURITY;
ALTER TABLE repos FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS repos_memex_isolation ON repos;
CREATE POLICY repos_memex_isolation ON repos
  USING (
    nullif(current_setting('app.memex_id', true), '') IS NOT NULL
    AND memex_id = current_setting('app.memex_id', true)::uuid
  )
  WITH CHECK (
    nullif(current_setting('app.memex_id', true), '') IS NOT NULL
    AND memex_id = current_setting('app.memex_id', true)::uuid
  );
