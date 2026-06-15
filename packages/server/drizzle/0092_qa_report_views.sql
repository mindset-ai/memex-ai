-- spec-260 t-1 — per-user QA Reports read-state marker (dec-6).
--
-- The only net-new table for the QA Report feature. One row per (user, memex) holding
-- the last time that user viewed the workspace QA Reports feed. Unread = count of
-- qa_report* doc_sections in the memex created after last_viewed_at (computed in the
-- service layer, NOT stored here). A NULL/absent marker means the user has never viewed
-- the feed, so every report counts.
--
-- This is per-user state, NOT an activity-bearing doc table, so the std-32 activity-
-- contract columns (actor_user_id / actor_name / channel) deliberately do NOT apply.
--
-- Tenancy (std-7): it carries a direct memex_id, so it takes the same memex_isolation
-- RLS policy as the Phase-2 tenant tables (0081) — the app.memex_id GUC must be set and
-- match the row. Per-user scoping (a user only ever reads/writes their OWN marker) is
-- enforced at the service layer, which always operates on the authenticated user's row;
-- RLS adds the cross-tenant 404 guarantee at the database level.

CREATE TABLE IF NOT EXISTS "qa_report_views" (
  "user_id" uuid NOT NULL REFERENCES "users" ("id") ON DELETE CASCADE,
  "memex_id" uuid NOT NULL REFERENCES "memexes" ("id") ON DELETE CASCADE,
  "last_viewed_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "qa_report_views_pkey" PRIMARY KEY ("user_id", "memex_id")
);

ALTER TABLE "qa_report_views" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "qa_report_views" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS qa_report_views_memex_isolation ON "qa_report_views";
CREATE POLICY qa_report_views_memex_isolation ON "qa_report_views"
  USING (
    nullif(current_setting('app.memex_id', true), '') IS NOT NULL
    AND memex_id = current_setting('app.memex_id', true)::uuid
  )
  WITH CHECK (
    nullif(current_setting('app.memex_id', true), '') IS NOT NULL
    AND memex_id = current_setting('app.memex_id', true)::uuid
  );

-- The restricted runtime role (memex_app, created in 0081) is the one RLS actually
-- bites. ALTER DEFAULT PRIVILEGES set in 0081 already grants it on tables created
-- afterwards, but this explicit grant is belt-and-braces for environments where the
-- default-privileges grant didn't apply.
GRANT SELECT, INSERT, UPDATE, DELETE ON "qa_report_views" TO memex_app;
