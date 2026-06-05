-- b-31 W1 t-19 (dec-8): OAuth tokens are Org-scoped.
--
-- A single OAuth access token grants access to the user's personal Memex +
-- one chosen Org. The Org is decided at /authorize time, carried in the
-- auth code, persisted with the refresh-token chain, and embedded in the
-- access JWT as the `org` claim.
--
-- Additive-only — no existing rows are touched. `mxt_` PATs (services/
-- mcp-tokens.ts) remain user-wide and unaffected.
--
-- `org_id` is NULLABLE because a user with no Org memberships authorises
-- against their personal Memex only — that's the zero-Org variant from
-- dec-8.

ALTER TABLE "oauth_authorization_codes"
  ADD COLUMN "org_id" uuid REFERENCES "orgs"("id") ON DELETE CASCADE;
--> statement-breakpoint

ALTER TABLE "oauth_refresh_tokens"
  ADD COLUMN "org_id" uuid REFERENCES "orgs"("id") ON DELETE CASCADE;
--> statement-breakpoint

-- Index covers the admin-side "revoke every OAuth token for this Org" path
-- and any per-user-per-org session listing (/settings/connected-clients).
CREATE INDEX "oauth_refresh_tokens_user_org_idx"
  ON "oauth_refresh_tokens" ("user_id", "org_id");
