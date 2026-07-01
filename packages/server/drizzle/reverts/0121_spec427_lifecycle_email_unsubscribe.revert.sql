-- Revert spec-427 t-4 (0121_spec427_lifecycle_email_unsubscribe.sql).
-- Drops the lifecycle-email suppression column. Any recorded unsubscribes are lost
-- on revert (the column IS the store) — acceptable for a schema rollback.
ALTER TABLE "users" DROP COLUMN IF EXISTS "lifecycle_email_unsubscribed_at";
