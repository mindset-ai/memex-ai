-- Revert of 0107_ac_reviewed_reason.sql (spec-391 t-1).
-- Drops the reviewed-verification rationale column. Any recorded reasons are
-- lost on revert — acceptable: it is advisory overlay state alongside
-- accepted_by/accepted_at; the test-derived verification state is unaffected.
--
-- Reverts are NOT auto-applied by the hand-migration runner — run manually with
-- psql against the target DB only if a regression forces a rollback.

ALTER TABLE acs
  DROP COLUMN IF EXISTS reviewed_reason;
