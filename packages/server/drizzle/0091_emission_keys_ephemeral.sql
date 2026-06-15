-- spec-234 t-1 — the two-key model on memex_emission_keys.
--
-- AC emission is served by two key types (dec-1): the existing PERMANENT / CI key
-- (human-minted in Settings, whole-memex, never expires) and a new EPHEMERAL / agent
-- key minted over MCP by provision_ac_emission. Both new columns are nullable and a
-- NULL pair is exactly today's permanent key, so every existing row keeps working
-- unchanged (additive, no backfill).
--
--   expires_at         — when set, the key stops authorising emissions once now()
--                        passes it (verifyEmissionKey gate, ac-10), with no human
--                        revoke. NULL = permanent. Agent keys set it ~2h ahead.
--   scoped_spec_handle — when set, the key may ONLY emit for ACs of this Spec — the
--                        `spec-N` handle from the ac_uid's `/specs/<handle>/` segment,
--                        matched in the /api/test-events gate (ac-11). NULL = whole-memex
--                        authorisation (the spec-129 default).
--
-- The pair is also the Settings-UI discriminator (ac-8): ephemeral = either column
-- non-null. No separate `kind` column needed.
--
-- RLS: memex_emission_keys is excluded from RLS (drizzle/0087_emission_keys_rls_exclusion),
-- because the unauthenticated POST /api/test-events path must read it to authenticate an
-- emission. Adding columns does not change that posture.

ALTER TABLE "memex_emission_keys"
  ADD COLUMN IF NOT EXISTS "expires_at" timestamp with time zone;

ALTER TABLE "memex_emission_keys"
  ADD COLUMN IF NOT EXISTS "scoped_spec_handle" text;

-- The verify gate filters on (hashed_key, revoked_at IS NULL, expiry). A partial index
-- on the live set keeps that lookup tight as expired/revoked rows accumulate; the unique
-- index on hashed_key already serves the equality, so this only narrows the scan.
CREATE INDEX IF NOT EXISTS "memex_emission_keys_live_idx"
  ON "memex_emission_keys" ("hashed_key")
  WHERE "revoked_at" IS NULL;
