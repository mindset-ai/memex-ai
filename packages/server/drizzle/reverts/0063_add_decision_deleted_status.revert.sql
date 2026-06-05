-- Revert b-97 t-2: restore the pre-soft-delete schema.
--
-- Two undo steps, mirroring the forward migration in reverse order:
--   1. Narrow the CHECK back to the four legacy statuses. Any row currently in
--      status='deleted' is reset to its captured previous_status first so the
--      constraint addition succeeds without a violation. previous_status is
--      guaranteed non-null when status='deleted' (set atomically by delete);
--      defence-in-depth COALESCE to 'open' just in case a manual write
--      bypassed that invariant.
--   2. Drop the previous_status column.

UPDATE decisions
   SET status = COALESCE(previous_status, 'open'),
       previous_status = NULL
 WHERE status = 'deleted';

ALTER TABLE decisions
  DROP CONSTRAINT decisions_status_valid;

ALTER TABLE decisions
  ADD CONSTRAINT decisions_status_valid
    CHECK (status IN ('open', 'resolved', 'candidate', 'rejected'));

ALTER TABLE decisions
  DROP COLUMN previous_status;
