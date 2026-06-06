-- Revert of 0078_add_ac_acceptance.sql (spec-188 t-1).
-- Drops the manual-acceptance overlay columns. Any recorded acceptances are
-- lost on revert — acceptable: the columns are advisory overlay state, the
-- test-derived verification state is unaffected.

ALTER TABLE acs
  DROP COLUMN IF EXISTS accepted_by,
  DROP COLUMN IF EXISTS accepted_at;
