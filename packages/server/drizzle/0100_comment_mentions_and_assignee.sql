-- spec-320 t-1: @-mention a user in a comment + assign a comment to one owner.
--
-- Three concepts stay distinct (dec-1): audience (visibility, doc_comments.audience,
-- untouched) ≠ mention (attention, the comment_mentions join table below) ≠ assignee
-- (ownership, the three columns added to doc_comments). A single comment can be
-- audience='all', @-mention several people, and be assigned to one of them, all at once.
--
-- Named CHECK / UNIQUE / index names match the Drizzle schema's check()/unique()/index()
-- names so introspection-by-conname and any future ALTER ... DROP CONSTRAINT stay in
-- lockstep. Idempotent (IF NOT EXISTS) so the hand-migration runner can re-apply cleanly.

-- 1. comment_mentions — multi-valued @-mention (dec-1) --------------------------------
--
-- A join table because one comment can call out several people (ac-1) — the inverse of
-- the single-owner assignee column added below. unique(comment_id,user_id) makes
-- mention-add idempotent (one mention per user per comment); user_id index backs the
-- spec-315 "mentions-me" read. mentioned_by/at are the std-32 WHO/WHEN. The invariant
-- assignee ⊆ mentions (dec-2) is enforced in the service layer, not the schema.
CREATE TABLE IF NOT EXISTS comment_mentions (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  memex_id     UUID NOT NULL,
  comment_id   UUID NOT NULL REFERENCES doc_comments(id) ON DELETE CASCADE,
  user_id      UUID NOT NULL REFERENCES users(id)        ON DELETE CASCADE,
  mentioned_by UUID REFERENCES users(id)                 ON DELETE SET NULL,
  at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT comment_mentions_comment_id_user_id_unique UNIQUE (comment_id, user_id)
);

CREATE INDEX IF NOT EXISTS comment_mentions_user_id_idx    ON comment_mentions (user_id);
CREATE INDEX IF NOT EXISTS comment_mentions_comment_id_idx ON comment_mentions (comment_id);

-- Tenancy (std-7): comment_mentions carries a direct memex_id, so it takes the same
-- memex_isolation RLS policy as the Phase-2 tenant tables (0081) — the app.memex_id GUC
-- must be set and match the row. Mirrors qa_report_views (0092).
ALTER TABLE comment_mentions ENABLE ROW LEVEL SECURITY;
ALTER TABLE comment_mentions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS comment_mentions_memex_isolation ON comment_mentions;
CREATE POLICY comment_mentions_memex_isolation ON comment_mentions
  USING (
    nullif(current_setting('app.memex_id', true), '') IS NOT NULL
    AND memex_id = current_setting('app.memex_id', true)::uuid
  )
  WITH CHECK (
    nullif(current_setting('app.memex_id', true), '') IS NOT NULL
    AND memex_id = current_setting('app.memex_id', true)::uuid
  );

-- The restricted runtime role (memex_app, created in 0081) is the one RLS bites.
-- ALTER DEFAULT PRIVILEGES in 0081 already grants on tables created afterwards, but this
-- explicit grant is belt-and-braces for environments where that didn't apply.
GRANT SELECT, INSERT, UPDATE, DELETE ON comment_mentions TO memex_app;

-- 2. doc_comments assignment columns (dec-1/dec-2) ------------------------------------
--
-- Single owner per comment, so it lives on the row (not a join table). The open→resolved
-- lifecycle reuses resolved_at/resolution — no assignment-specific status column.
-- assigned_by/assigned_at are the std-32 WHO/WHEN. ON DELETE SET NULL keeps the comment
-- when the referenced user is removed (mirrors doc_assignees.assigned_by).
ALTER TABLE doc_comments
  ADD COLUMN IF NOT EXISTS assignee_user_id UUID REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE doc_comments
  ADD COLUMN IF NOT EXISTS assigned_by      UUID REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE doc_comments
  ADD COLUMN IF NOT EXISTS assigned_at      TIMESTAMPTZ;

-- The spec-315 "open assignments to me" read path: assignee_user_id = :me AND
-- resolved_at IS NULL. Partial so the index only carries OPEN assignments (resolving the
-- comment closes the assignment, dropping the row from the index).
CREATE INDEX IF NOT EXISTS doc_comments_open_assignee_idx
  ON doc_comments (assignee_user_id)
  WHERE resolved_at IS NULL;
