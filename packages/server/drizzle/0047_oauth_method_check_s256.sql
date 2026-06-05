-- b-31 t-28: Tighten the code_challenge_method CHECK to S256 only.
--
-- The original 0045 migration allowed ('S256', 'plain') for forward-compat,
-- but per OAuth 2.1 / MCP spec we never accept 'plain'. The runtime guards in
-- services/oauth/codes.ts:52 + :139 already reject plain at the service layer
-- — this tightens the DB constraint as defence-in-depth.
--
-- Safe-by-default: we abort the migration if any pre-existing rows have
-- method != 'S256'. In practice the runtime guard means no such rows can
-- exist, but the SELECT is a fail-safe in case manual data was inserted.

DO $$
DECLARE
  bad_count integer;
BEGIN
  SELECT COUNT(*) INTO bad_count
  FROM oauth_authorization_codes
  WHERE code_challenge_method <> 'S256';

  IF bad_count > 0 THEN
    RAISE EXCEPTION 'Cannot tighten oauth_auth_codes_method_valid: % row(s) have code_challenge_method <> ''S256''', bad_count;
  END IF;
END $$;
--> statement-breakpoint

ALTER TABLE "oauth_authorization_codes"
  DROP CONSTRAINT "oauth_auth_codes_method_valid";
--> statement-breakpoint

ALTER TABLE "oauth_authorization_codes"
  ADD CONSTRAINT "oauth_auth_codes_method_valid"
  CHECK ("code_challenge_method" = 'S256');
