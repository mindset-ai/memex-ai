-- spec-371 rework (dec-5, dec-11, dec-12): the durable, single-holder CHECKOUT
-- record, stamped on the spec's own documents row. This replaces the merged v1's
-- presence-coupled claim (which wrongly welded checkout onto the ephemeral
-- presence plane). One current holder per spec; a new checkout supersedes.
--   checked_out_by     — the user who currently holds it (null = free)
--   checked_out_at     — when they took it (drives the collision window, dec-11)
--   checked_out_thread — the Claude Code conversation UID, or "web"/null (dec-12)
-- Hand-written (additive ADD COLUMN, no rename ambiguity) — same mechanism as 0107.
ALTER TABLE "documents" ADD COLUMN IF NOT EXISTS "checked_out_by" uuid REFERENCES "users"("id") ON DELETE SET NULL;
ALTER TABLE "documents" ADD COLUMN IF NOT EXISTS "checked_out_at" timestamptz;
ALTER TABLE "documents" ADD COLUMN IF NOT EXISTS "checked_out_thread" text;
CREATE INDEX IF NOT EXISTS "documents_checked_out_by_idx" ON "documents" ("checked_out_by");
