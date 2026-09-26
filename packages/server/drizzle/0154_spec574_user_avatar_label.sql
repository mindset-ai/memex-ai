-- spec-574: the letters a person nominates for their avatar. Null = no nomination, and
-- the avatar derives its letters from the name. No default and no backfill: nobody has
-- a nomination until they set one on their profile page. The CHECK mirrors
-- AVATAR_LABEL_MAX_LENGTH in @memex/shared (one or two letters, stored upper-cased).
-- users is global (not RLS/memex-scoped), so no policy change is needed. The CHECK is
-- validated against a column that is null on every row. Idempotent — re-running is a no-op.
-- Lock safety: ADD COLUMN and ADD CONSTRAINT take ACCESS EXCLUSIVE on users, which every
-- authenticated request reads. Without a timeout, a long-running reader would queue this
-- ALTER and every request behind it. With it, the deploy fails fast instead and can be
-- retried; the applier runs the file in one transaction, so SET LOCAL covers every
-- statement below.
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
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
