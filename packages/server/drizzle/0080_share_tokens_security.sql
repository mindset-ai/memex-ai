-- spec-199 t-3: add created_by_user_id FK and expires_at to share_tokens
--
-- created_by_user_id: nullable so existing rows keep working (backward compat).
-- ON DELETE SET NULL so tokens survive if the user row is hard-deleted
-- (membership disable does not delete the user — it only sets status=disabled).
--
-- expires_at: nullable; no default here — the application layer stamps the value
-- at mint time using a configurable TTL (SHARE_TOKEN_TTL_DAYS env var). Null
-- means no expiry (preserves existing tokens that pre-date this migration).

ALTER TABLE "share_tokens"
  ADD COLUMN "created_by_user_id" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  ADD COLUMN "expires_at" timestamptz;

-- Index to make the bulk-revoke in disableMembership efficient.
CREATE INDEX "share_tokens_created_by_user_id_idx" ON "share_tokens" ("created_by_user_id");
