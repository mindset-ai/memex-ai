-- spec-352 (parent spec-345, perf-1) — make the Home activity-feed query
-- index-servable.
--
-- WHY
--   services/home-specs.ts drives the activity_view (0089, an 8-arm UNION ALL)
--   twice per Memex inside a per-Memex loop:
--     Q-mine  : WHERE actor_user_id = $me AND spec_ref IS NOT NULL
--                 AND memex_id = $m AND at >= $window   GROUP BY spec_ref
--     Q-spark : WHERE memex_id = $m AND spec_ref IN (...) AND at >= $spark
--                 ORDER BY at DESC LIMIT 1000
--   Because activity_view is a plain view, the planner pushes each arm's
--   predicate into the underlying table. Baseline EXPLAIN showed:
--     - doc_sections did a SEQ SCAN on Q-mine (no actor_user_id index),
--     - test_events did a SEQ SCAN on both arms (its join key is a substring
--       of ac_uid, only the created_at window can prune it),
--     - the arms keyed by spec_ref (tasks/decisions/doc_comments) fell back to
--       the single-column *_memex_id_idx, then filtered doc_id + window in the
--       heap rather than being served end-to-end by one index.
--
-- WHAT — two index families per hot arm, matching the planner's actual filters
--   (the view projects `at` as created_at, or COALESCE(updated_at, created_at)
--   where an updated_at exists; we index created_at, which the planner already
--   uses as the leading window predicate on every arm):
--
--   Q-spark covering composite — (memex_id, <spec_ref col>, created_at):
--     serves memex_id = $m AND spec_ref IN (...) AND created_at >= $spark from a
--     single index range, no heap filter for the join key.
--   Q-mine covering composite — (actor_user_id, created_at):
--     serves actor_user_id = $me AND created_at >= $window; partial WHERE
--     actor_user_id IS NOT NULL so the index only carries attributable rows
--     (the documents / test_events arms carry NULL actor and are constraint-
--     excluded from Q-mine entirely — they never touch these indexes).
--
-- acs/decisions already have a partial actor_user_id index (0098); they only
-- need the spark composite. doc_sections has no memex_id column (the view
-- derives it via a documents sub-select), so its spark composite is keyed on
-- doc_id alone. test_events gets a created_at index so its window prunes the
-- scan before the handle join.
--
-- Idempotent (IF NOT EXISTS); applied by scripts/apply-hand-migrations.mjs and
-- tracked in manual_migrations.

-- ── Q-spark: (memex_id, spec_ref, created_at) covering composites ─────────────
CREATE INDEX IF NOT EXISTS acs_memex_brief_created_at_idx
  ON acs (memex_id, brief_id, created_at);

CREATE INDEX IF NOT EXISTS tasks_memex_doc_created_at_idx
  ON tasks (memex_id, doc_id, created_at);

CREATE INDEX IF NOT EXISTS decisions_memex_doc_created_at_idx
  ON decisions (memex_id, doc_id, created_at);

CREATE INDEX IF NOT EXISTS doc_comments_memex_doc_created_at_idx
  ON doc_comments (memex_id, doc_id, created_at);

-- doc_sections has no memex_id column — the view derives the tenant via a
-- per-row documents sub-select, so the spark filter on this arm reduces to
-- doc_id IN (...) AND created_at >= window.
CREATE INDEX IF NOT EXISTS doc_sections_doc_created_at_idx
  ON doc_sections (doc_id, created_at);

-- ── Q-mine: (actor_user_id, created_at) partial composites on the arms that
--    lacked an actor index (acs/decisions already covered by 0098) ────────────
CREATE INDEX IF NOT EXISTS tasks_actor_created_at_idx
  ON tasks (actor_user_id, created_at) WHERE actor_user_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS doc_sections_actor_created_at_idx
  ON doc_sections (actor_user_id, created_at) WHERE actor_user_id IS NOT NULL;

-- doc_comments' WHO column is author_user_id (no actor_* columns on this table).
CREATE INDEX IF NOT EXISTS doc_comments_author_created_at_idx
  ON doc_comments (author_user_id, created_at) WHERE author_user_id IS NOT NULL;

-- ── test_events: the spark/mine window is the only prunable predicate (the
--    spec_ref join is a substring of ac_uid). A plain created_at index lets the
--    14d/90d window cut the scan before the documents handle-join. ────────────
CREATE INDEX IF NOT EXISTS test_events_created_at_idx
  ON test_events (created_at);
