-- Revert spec-442 (0120_spec_442_fix_comms_log_email_tracking.sql).
-- Drops only the forward-guard constraint. The two data backfills (type re-mapping
-- and sent_at = created_at) are DATA CORRECTIONS and are NOT reversed: the prior
-- state (auth rows mis-typed 'transactional', sent_at NULL) was the defect, and the
-- original per-row values are not recoverable. Dropping the constraint is enough to
-- restore the pre-0120 schema shape.
ALTER TABLE "comms_log" DROP CONSTRAINT IF EXISTS "comms_log_sent_requires_sent_at";
