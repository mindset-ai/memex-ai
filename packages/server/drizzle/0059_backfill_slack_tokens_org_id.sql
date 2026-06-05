-- b-56 t-6: backfill org_id on existing user_slack_tokens rows where org_id IS NULL.
--
-- Strategy: for users with exactly one active org membership, set org_id to that org.
-- Users with zero or multiple org memberships are left as NULL — they must reconnect
-- per-org to disambiguate. NULL rows continue to function as a legacy global fallback
-- until they reconnect (see b-56 overview §2, migration option B).
--
-- Idempotent: WHERE org_id IS NULL means already-backfilled rows are skipped on re-run.

WITH single_org_users AS (
  SELECT user_id, MIN(org_id::text)::uuid AS org_id
  FROM org_memberships
  WHERE status = 'active'
  GROUP BY user_id
  HAVING COUNT(DISTINCT org_id) = 1
)
UPDATE user_slack_tokens
SET org_id = sou.org_id
FROM single_org_users sou
WHERE user_slack_tokens.user_id = sou.user_id
  AND user_slack_tokens.org_id IS NULL;
