ALTER TABLE user_slack_tokens DROP CONSTRAINT IF EXISTS user_slack_tokens_user_org_unique;
ALTER TABLE user_slack_tokens DROP COLUMN IF EXISTS org_id;
ALTER TABLE user_slack_tokens ADD PRIMARY KEY (user_id);
