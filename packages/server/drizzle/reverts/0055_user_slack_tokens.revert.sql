-- Manual rollback for 0055_user_slack_tokens.sql. The hand-migration runner has no
-- revert mode; this file lives outside `drizzle/*.sql` (in `drizzle/reverts/`) so the
-- runner won't auto-apply it. Operators run it via psql when an explicit rollback is
-- required (development testing, emergency unwind).
--
--   psql "$DATABASE_URL" -f drizzle/reverts/0055_user_slack_tokens.revert.sql
--   psql "$DATABASE_URL" -c "DELETE FROM manual_migrations WHERE filename = '0055_user_slack_tokens';"
--
-- WARNING: dropping the table irreversibly destroys all stored Slack OAuth tokens.
-- Users will need to re-authorise via the Connect Slack flow. There is no recovery.

DROP INDEX IF EXISTS user_slack_tokens_workspace_idx;
DROP TABLE IF EXISTS user_slack_tokens;
