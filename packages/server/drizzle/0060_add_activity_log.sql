-- b-60 t-1: the activity_log table — Pulse's append-only feed of what happened
-- across a Memex (and per-Brief), regardless of which surface drove the change.
--
-- Every meaningful mutation writes one row here. Rows are immutable once written
-- (no updated_at) — Pulse renders the narrative as a chronological timeline.
--
-- Dimensions per row:
--   actor_kind — WHO acted: a human, an MCP agent, the in-app agent, or the system.
--   channel    — THROUGH WHAT surface the action arrived: the REST UI, the MCP
--                endpoint, the in-app agent, or a server-internal process.
--   client_id  — opaque per-client correlation id (e.g. a device/installation) used
--                to thread a single actor's activity across requests. Nullable.
--   entity / action — the structured "doc / created", "task / completed" pair.
--   narrative  — the human-readable one-liner Pulse displays.
--   payload    — optional structured detail (jsonb) for richer rendering / future use.
--
-- FKs match the real table names in db/schema.ts: memexes(id), documents(id) (a Brief
-- is a document with doc_type='brief'), users(id). brief_id and actor_user_id are
-- nullable + ON DELETE SET NULL so deleting a Brief or user keeps the historical
-- activity row (it just loses the live link). memex_id is NOT NULL + ON DELETE CASCADE
-- — activity has no meaning without its Memex.

CREATE TABLE activity_log (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  memex_id      UUID NOT NULL REFERENCES memexes(id) ON DELETE CASCADE,
  brief_id      UUID REFERENCES documents(id) ON DELETE SET NULL,
  actor_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  actor_kind    TEXT NOT NULL CHECK (actor_kind IN ('human', 'mcp_agent', 'in_app_agent', 'system')),
  channel       TEXT NOT NULL CHECK (channel IN ('rest_ui', 'mcp', 'in_app_agent', 'server')),
  client_id     TEXT,
  entity        TEXT NOT NULL,
  action        TEXT NOT NULL,
  narrative     TEXT NOT NULL,
  payload       JSONB,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Primary timeline read: most-recent activity for a Memex.
CREATE INDEX activity_log_memex_id_created_at_idx
  ON activity_log (memex_id, created_at DESC);

-- Per-Brief timeline. Partial — only rows attached to a Brief.
CREATE INDEX activity_log_brief_id_created_at_idx
  ON activity_log (brief_id, created_at DESC)
  WHERE brief_id IS NOT NULL;

-- "What did this actor do from this client" threading. Partial — only attributed rows.
CREATE INDEX activity_log_actor_user_id_client_id_created_at_idx
  ON activity_log (actor_user_id, client_id, created_at DESC)
  WHERE actor_user_id IS NOT NULL;
