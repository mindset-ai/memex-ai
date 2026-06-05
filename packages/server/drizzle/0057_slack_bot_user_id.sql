-- doc-23: store the Slack bot user ID returned by oauth.v2.access so the
-- send_slack_message tool can construct a proper <@U…> app-mention footer.
-- Nullable — existing rows won't have it; populated on next connect/reconnect.

ALTER TABLE user_slack_tokens
  ADD COLUMN IF NOT EXISTS slack_bot_user_id TEXT;
