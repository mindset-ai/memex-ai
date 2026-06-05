-- Adds native email/password + email-verification + magic-link infrastructure
-- alongside the existing Google SSO path.
--
--   * users.password_hash: nullable (Google-SSO-only users don't have one).
--   * users.email_verified_at: nullable until proven. Set by Google SSO (when Google
--     says email_verified=true), email-verification token, or magic-link consumption.
--   * auth_tokens: single-use tokens for email_verification / magic_link /
--     password_reset. Stored as a sha256 hash; the raw token is emailed and never
--     persisted. `email` is denormalised so magic-link signup (no user yet) works.

ALTER TABLE "users" ADD COLUMN "password_hash" text;
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "email_verified_at" timestamptz;
--> statement-breakpoint
CREATE TABLE "auth_tokens" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "purpose" text NOT NULL,
  "user_id" uuid REFERENCES "users"("id") ON DELETE CASCADE,
  "email" text NOT NULL,
  "token_hash" text NOT NULL UNIQUE,
  "expires_at" timestamptz NOT NULL,
  "consumed_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "auth_tokens_purpose_valid"
    CHECK ("purpose" IN ('email_verification', 'magic_link', 'password_reset'))
);
--> statement-breakpoint
CREATE INDEX "auth_tokens_email_purpose_idx" ON "auth_tokens" ("email", "purpose");
