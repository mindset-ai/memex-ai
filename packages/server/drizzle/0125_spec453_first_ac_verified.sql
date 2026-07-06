-- spec-453 (dec-9 / dec-10): the "See it verified" activation-email GATE SENTINEL.
-- Hand-written migration (this repo's journal is frozen at 0008; everything since is
-- applied by scripts/apply-hand-migrations.mjs and tracked in manual_migrations).
--
-- Adds a nullable first_ac_verified_at to the GLOBAL users table:
--   * NO RLS policy — users is not tenancy-scoped (std-36).
--   * NO DEFAULT on purpose — a DEFAULT now() would auto-stamp every new signup, so
--     NULL would never occur and nobody would ever be eligible for the milestone email.
-- Then BACKFILLS it to deploy-time for every pre-existing row (dec-10): this excludes
-- the existing back-catalogue from the one-time "See it verified" email AND stops a
-- pre-existing user from false-triggering it on a LATER verification (their column is
-- already non-NULL). NULL after this migration = a post-go-live account that has not
-- yet had an acceptance criterion verified. One-shot: apply-hand-migrations runs it once.
ALTER TABLE users ADD COLUMN IF NOT EXISTS first_ac_verified_at timestamp with time zone;
--> statement-breakpoint
UPDATE users SET first_ac_verified_at = now() WHERE first_ac_verified_at IS NULL;
