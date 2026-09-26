-- spec-574: the letters a person nominates for their avatar. Null = no nomination, and
-- the avatar derives its letters from the name. No default and no backfill: nobody has
-- a nomination until they set one on their profile page. The CHECK mirrors
-- AVATAR_LABEL_MAX_LENGTH in @memex/shared (one or two letters, stored upper-cased).
-- users is global (not RLS/memex-scoped), so no policy change is needed. The CHECK is
-- validated against a column that is null on every row. Idempotent — re-running is a no-op.
ALTER TABLE "users"
  ADD COLUMN IF NOT EXISTS "avatar_label" text;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'users_avatar_label_length'
  ) THEN
    ALTER TABLE "users"
      ADD CONSTRAINT "users_avatar_label_length"
      CHECK ("avatar_label" IS NULL OR char_length("avatar_label") BETWEEN 1 AND 2);
  END IF;
END $$;
