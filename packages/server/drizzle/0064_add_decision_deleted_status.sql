-- b-97 t-2: extend the decision lifecycle with a soft-delete status.
--
-- Two changes, one atomic migration:
--   1. Add `previous_status` (nullable text). Captures the status the decision
--      held at the moment delete_decision was called, so update_decision can
--      restore it without the caller needing to remember.
--   2. Extend the `decisions_status_valid` CHECK to include 'deleted'. Drop +
--      recreate (Postgres doesn't support ALTER on a CHECK in place).
--
-- No data backfill. Every existing row has `previous_status = NULL`, which is
-- correct — none of them are deleted, so there's no prior status to capture.
-- The CHECK widens the accepted set; no existing row violates the new constraint.
--
-- Idempotent (IF [NOT] EXISTS): some environments (e.g. int) already carried
-- the `previous_status` column / widened CHECK from an earlier b-97 touch that
-- wasn't recorded in `manual_migrations`, so a plain ADD COLUMN aborted the
-- hand-migration runner. Guarding each step lets the runner re-apply cleanly
-- and record the migration without double-applying DDL.

ALTER TABLE decisions
  ADD COLUMN IF NOT EXISTS previous_status text;

ALTER TABLE decisions
  DROP CONSTRAINT IF EXISTS decisions_status_valid;

ALTER TABLE decisions
  ADD CONSTRAINT decisions_status_valid
    CHECK (status IN ('open', 'resolved', 'candidate', 'rejected', 'deleted'));
