-- org_discord_webhooks: per-org Discord webhook URL for memex__send_discord_message (spec-138 dec-1).
-- One webhook per org (UNIQUE on org_id). Webhook URLs are treated as non-secret configuration
-- (Discord recommends rotating them if leaked) so no envelope encryption is applied — unlike
-- user_slack_tokens. Stored as plaintext text column. Channel_name is a display label only;
-- it is NOT used for routing — routing always goes to the webhook URL's embedded channel.
--
-- Deletion cascades from orgs: if the org is deleted, its webhook row goes with it.
-- Hard-delete on disconnect (no soft-delete): webhook URLs carry no audit-trail requirement.

CREATE TABLE IF NOT EXISTS org_discord_webhooks (
  org_id       uuid PRIMARY KEY REFERENCES orgs(id) ON DELETE CASCADE,
  webhook_url  text NOT NULL,
  channel_name text,
  created_at   timestamp with time zone NOT NULL DEFAULT now(),
  updated_at   timestamp with time zone NOT NULL DEFAULT now()
);
