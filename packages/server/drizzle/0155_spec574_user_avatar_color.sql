-- spec-574: the palette colour a person picked for their avatar, stored as the palette
-- key (AVATAR_COLORS in @memex/shared). Null = the neutral default, which is how every
-- avatar looks today. No default and no backfill: nobody's colour changes until they
-- pick one. The CHECK constrains the SHAPE only, so adding a palette colour needs no
-- migration; a key later retired from the palette renders as the neutral default.
-- users is global (not RLS/memex-scoped), so no policy change is needed. The CHECK is
-- validated against a column that is null on every row. Idempotent — re-running is a no-op.
ALTER TABLE "users"
  ADD COLUMN IF NOT EXISTS "avatar_color" text;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'users_avatar_color_shape'
  ) THEN
    ALTER TABLE "users"
      ADD CONSTRAINT "users_avatar_color_shape"
      CHECK ("avatar_color" IS NULL OR "avatar_color" ~ '^[a-z]{1,20}$');
  END IF;
END $$;
