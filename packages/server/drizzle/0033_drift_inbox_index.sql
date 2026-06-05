-- Drift Inbox supporting index (services/drift-inbox.ts).
--
-- The Drift Inbox query selects open `drift` + `plan_revision` typed comments per
-- account, ordered by (created_at DESC, id DESC) for cursor pagination. Without a
-- supporting index this is a seq scan over `doc_comments` + a sort step — fine for
-- MVP scale, expensive once a tenant accumulates thousands of resolved comments.
--
-- The multicolumn index covers the WHERE + ORDER BY:
--   account_id   — equality predicate
--   comment_type — IN ('drift', 'plan_revision') predicate
--   created_at   — ORDER BY DESC + cursor predicate
--   id           — ORDER BY DESC tiebreaker for stable cursor pagination
--
-- Postgres can scan this index in reverse to satisfy the ORDER BY without a sort,
-- and the cursor's `(created_at, id) < ($cursor_ts, $cursor_id)` becomes a single
-- index range scan.
--
-- We do NOT add a partial index on `WHERE resolved_at IS NULL` even though the
-- query also filters that. Resolved comments still need the index for the rare
-- "show resolved drift" view, and a partial index would silently stop covering
-- that path. The non-partial index is small (drift + plan_revision are a tiny
-- fraction of doc_comments) and catches both shapes.

CREATE INDEX IF NOT EXISTS "doc_comments_drift_inbox_idx"
  ON "doc_comments" ("account_id", "comment_type", "created_at" DESC, "id" DESC);
