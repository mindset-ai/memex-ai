-- spec-178 t-1 (ac-9): add is_demo flag to the documents table.
--
-- When true, marks the document as one of the five frozen copies of the canonical
-- ⌘K-search Spec (spec-64) seeded into a personal Memex for the multi-phase Handhold
-- onboarding demo. Demo docs render a DEMO badge + per-phase value banner, suppress
-- handle auto-linking, are excluded from ⌘K/search and every agent surface (dec-11;
-- only the board REST list/get returns them), and excluded from Pulse/usage analytics.
-- The reset endpoint (POST .../handhold/reset) hard-deletes all is_demo docs (and their
-- seeded test-event emissions) and re-seeds from handhold-demo.fixture.ts.
--
-- Additive + reversible: a single NOT NULL boolean column with a safe default (false).
-- Every existing row gets false, which is correct — no existing docs are demo docs.
-- The revert is simply DROP COLUMN.
--
-- Idempotent (IF NOT EXISTS): the hand-migration runner wraps each file in a
-- transaction and tracks it in manual_migrations; the guard lets a retry re-apply
-- cleanly if a prior run committed the DDL but not the tracking row.

ALTER TABLE documents
  ADD COLUMN IF NOT EXISTS is_demo boolean NOT NULL DEFAULT false;
