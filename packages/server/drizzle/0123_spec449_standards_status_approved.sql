-- spec-449 dec-1: Standards have no status lifecycle — a Standard is in force the
-- moment it exists. Normalize every existing standard row to the single canonical
-- 'approved' state so no standard reports 'draft' (the removed draft/approved
-- concept). Agent-created standards were previously born 'draft'; seeded/fixture
-- and prod standards already read 'approved', so in practice this touches only the
-- stragglers.
--
-- Scoped to doc_type='standard' ONLY — Specs (phase machine) and execution plans
-- ('approved' terminal state) are untouched. No column add/drop: the shared
-- documents.status column and its documents_status_valid CHECK already permit
-- 'approved'. Idempotent — the WHERE clause skips rows already normalized, so
-- re-running is a no-op. Bounded single UPDATE on a small table; no lock-ordering
-- concern against hot paths (std-39).
UPDATE "documents"
  SET "status" = 'approved'
  WHERE "doc_type" = 'standard' AND "status" <> 'approved';
