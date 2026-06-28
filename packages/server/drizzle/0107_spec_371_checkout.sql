-- spec-371: spec-checkout foundation.
-- Hand-written (drizzle-kit generate needs a TTY for its rename resolver; these
-- are two brand-new tables with no rename ambiguity, so a hand migration is the
-- clean path — same mechanism as 0047/0074). Applied by apply-hand-migrations.mjs.

-- The scoped hook credential (mxh_) — least privilege, authorises ONLY the
-- record-only phone-home. Modeled on memex_emission_keys (spec-129). dec-6.
CREATE TABLE IF NOT EXISTS "memex_hook_keys" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "memex_id" uuid NOT NULL REFERENCES "memexes"("id") ON DELETE CASCADE,
  "name" text NOT NULL,
  "hashed_key" text NOT NULL UNIQUE,
  "prefix" text NOT NULL,
  "created_by_user_id" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "last_used_at" timestamptz,
  "revoked_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "memex_hook_keys_memex_id_idx" ON "memex_hook_keys" ("memex_id");
CREATE INDEX IF NOT EXISTS "memex_hook_keys_created_by_user_id_idx" ON "memex_hook_keys" ("created_by_user_id");

-- The record-only edit ledger + footprint join key. dec-8.
CREATE TABLE IF NOT EXISTS "spec_checkout_edits" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "memex_id" uuid NOT NULL REFERENCES "memexes"("id") ON DELETE CASCADE,
  "doc_id" uuid NOT NULL REFERENCES "documents"("id") ON DELETE CASCADE,
  "thread_uid" text NOT NULL,
  "changed_paths" jsonb NOT NULL,
  "commit_sha" text,
  "branch" text,
  "actor_user_id" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "spec_checkout_edits_memex_doc_idx" ON "spec_checkout_edits" ("memex_id", "doc_id");
CREATE INDEX IF NOT EXISTS "spec_checkout_edits_thread_uid_idx" ON "spec_checkout_edits" ("thread_uid");
