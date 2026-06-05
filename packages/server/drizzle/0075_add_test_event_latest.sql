-- spec-162: test_event_latest summary table + one-time backfill.
--
-- An incrementally-maintained "latest event per (ac_uid, test_identifier)"
-- rollup over the append-only test_events log. The kanban acHealth read
-- (aggregateAcHealthForBriefs) and the per-Spec AC tab (listAcsForBriefWithVerification)
-- read from HERE instead of scanning all of test_events, making the read
-- O(active AC×test pairs) rather than O(total history) (ac-1).
--
-- Hand-written per the repo's two-tier migration convention (TEST.md): the
-- drizzle journal is frozen at 0008; everything 0009+ is applied by
-- scripts/apply-hand-migrations.sh, which wraps this file in a single
-- transaction — so the CREATE and the backfill below are atomic.
--
-- dec-2: test_identifier is NOT NULL DEFAULT '' because a Postgres primary key
-- cannot contain NULL, and '' mirrors the runtime key the JS reduce used
-- (ev.testIdentifier ?? "") so the summary and prior behaviour agree by
-- construction.

CREATE TABLE IF NOT EXISTS test_event_latest (
  ac_uid          text NOT NULL,
  test_identifier text NOT NULL DEFAULT '',
  latest_status   text NOT NULL,
  latest_run_at   timestamptz NOT NULL,
  run_count       integer NOT NULL DEFAULT 0,
  CONSTRAINT test_event_latest_pkey PRIMARY KEY (ac_uid, test_identifier),
  CONSTRAINT test_event_latest_status_valid CHECK (latest_status IN ('pass', 'fail', 'error'))
);

-- One-time backfill from existing history (ac-4, ac-11). Per
-- (ac_uid, COALESCE(test_identifier,'')): latest_status / latest_run_at come from
-- the newest NON-HIDDEN event (DISTINCT ON + created_at DESC, id DESC tiebreak),
-- and run_count is the count of NON-HIDDEN events (window COUNT(*) over the same
-- partition). A pair whose events are ALL hidden produces no row. ON CONFLICT DO
-- NOTHING makes this idempotent and re-runnable, and yields to any newer value
-- the live upsert path may already have written after deploy.
INSERT INTO test_event_latest (ac_uid, test_identifier, latest_status, latest_run_at, run_count)
SELECT DISTINCT ON (te.ac_uid, COALESCE(te.test_identifier, ''))
  te.ac_uid,
  COALESCE(te.test_identifier, '')                                         AS test_identifier,
  te.status                                                               AS latest_status,
  te.created_at                                                           AS latest_run_at,
  COUNT(*) OVER (PARTITION BY te.ac_uid, COALESCE(te.test_identifier, '')) AS run_count
FROM test_events te
WHERE te.hidden = false
ORDER BY te.ac_uid, COALESCE(te.test_identifier, ''), te.created_at DESC, te.id DESC
ON CONFLICT (ac_uid, test_identifier) DO NOTHING;
