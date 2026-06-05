-- b-56 t-1: scope Slack tokens to (user_id, org_id) instead of just user_id.
--
-- Current shape: user_id is PRIMARY KEY → one global token per user.
-- Target shape:  (user_id, org_id) unique with NULLS NOT DISTINCT → one token per
--                user per org; existing rows keep org_id = NULL as a legacy global
--                fallback until they reconnect (see t-6 for the backfill).
--
-- NULLS NOT DISTINCT (PG 15+, we run PG 16) means two rows with the same user_id
-- and org_id = NULL are considered duplicates — one legacy row per user is the limit.

ALTER TABLE user_slack_tokens
  DROP CONSTRAINT user_slack_tokens_pkey;

ALTER TABLE user_slack_tokens
  ADD COLUMN org_id UUID REFERENCES orgs(id) ON DELETE CASCADE;

ALTER TABLE user_slack_tokens
  ADD CONSTRAINT user_slack_tokens_user_org_unique
  UNIQUE NULLS NOT DISTINCT (user_id, org_id);
