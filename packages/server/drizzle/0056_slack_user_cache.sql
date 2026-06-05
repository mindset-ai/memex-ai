-- doc-23 T-7: display-name → Slack user-ID cache.
--
-- Avoids hammering Slack's users.list endpoint for repeat lookups. Keyed by
-- (workspace, normalised display_name). TTL is enforced at query time (7 days
-- per §6 of doc-23); stale rows are harmless until refreshed by the next miss.
--
-- Workspace-scoped (not memex-scoped). Per std-8 §6 the cache is silent-allowed
-- — writes flow through mutate({silent:true}) but no SSE consumer subscribes.

CREATE TABLE slack_user_cache (
  slack_workspace_id TEXT        NOT NULL,
  display_name       TEXT        NOT NULL,
  slack_user_id      TEXT        NOT NULL,
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (slack_workspace_id, display_name)
);

CREATE INDEX slack_user_cache_updated_at_idx
  ON slack_user_cache (updated_at);
