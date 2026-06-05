-- Invite tokens become multi-use: a link stays valid until explicitly revoked or expires_at
-- is reached. Previously a single `used` boolean flipped true on first claim — that forced
-- admins to mint one invite per person, which wasn't the intended UX.
--
-- Backfill: any row previously marked used is treated as revoked (set revoked_at = NOW()).

ALTER TABLE "invite_tokens" ADD COLUMN IF NOT EXISTS "revoked_at" timestamp with time zone;
--> statement-breakpoint

UPDATE "invite_tokens" SET "revoked_at" = NOW() WHERE "used" = true AND "revoked_at" IS NULL;
--> statement-breakpoint

ALTER TABLE "invite_tokens" DROP COLUMN IF EXISTS "used";
