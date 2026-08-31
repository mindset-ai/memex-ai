-- Manual rollback for 0142_spec520_partition_test_events.sql. The hand-migration runner has
-- no revert mode; this file lives outside `drizzle/*.sql` (in `drizzle/reverts/`) so the
-- runner won't auto-apply it. Operators run it via psql when an explicit rollback is
-- required.
--
--   psql "$DATABASE_URL" -f drizzle/reverts/0142_spec520_partition_test_events.revert.sql
--   psql "$DATABASE_URL" -c "DELETE FROM manual_migrations WHERE filename = '0142_spec520_partition_test_events';"
--
-- ══ READ THIS BEFORE RUNNING IT ══════════════════════════════════════════════════════════
--
-- ⚠ YOU ALMOST CERTAINLY DO NOT NEED THIS FILE. The previous application code runs
-- UNCHANGED against the partitioned table — verified: the old per-pair trim's
-- `DELETE ... WHERE id IN (SELECT ... OFFSET 10)` executes normally against a partitioned
-- parent and produced exactly its old behaviour (15 rows trimmed to 10). Nothing in the
-- pre-0142 code depends on the table being unpartitioned, and nothing looks a test_event up
-- by `id` alone, so widening the PK to (id, created_at) breaks no query.
--
-- So the FIRST rollback move is to redeploy the previous revision and leave the schema
-- alone. The trim simply starts deleting again — wasteful, not wrong. Reverting an
-- application deploy is a routine, reversible act; unpicking a schema on a table taking
-- ~31 writes/second is not. Reach for this file only if the PARTITIONING ITSELF is the
-- problem.
--
-- ⚠ THE IRREVERSIBLE MOMENT IS NOT THIS MIGRATION — IT IS THE FIRST PARTITION DROP.
-- 0142 copies and deletes nothing: every pre-existing row stays in `test_events_legacy`,
-- physically the same rows in the same table, merely renamed and attached. Data starts
-- disappearing only when `scripts/maintain-test-events-partitions.mjs` drops an aged-out
-- partition, and the legacy partition is dropped once its upper bound (the midnight after
-- the migration) is older than TEST_EVENTS_RETENTION_DAYS.
--
-- With the default 3-day window that is roughly FOUR DAYS after the migration — and only on
-- a deploy, because maintenance runs from deploy.sh and nowhere else. No deploy, no drop.
-- Check before assuming you still have a clean window:
--
--   SELECT count(*) FROM pg_class c JOIN pg_inherits i ON i.inhrelid = c.oid
--    WHERE i.inhparent = 'test_events'::regclass AND c.relname = 'test_events_legacy';
--
-- 1 = the pre-migration history is intact and this file restores everything.
-- 0 = it has been dropped. This file will still run and still preserve every row that
--     remains, but the days already dropped are gone and only a backup brings them back.
--
-- ⚠ ROWS WRITTEN AFTER THE CUTOVER ARE PRESERVED, and that is the part a naive revert gets
-- wrong. They live in the daily partitions, not in legacy, so detaching legacy and dropping
-- the parent would silently discard every emission since the migration. This file detaches
-- legacy FIRST (while attached, its range bound forbids post-cutover timestamps), copies the
-- remaining rows back into it, and only then drops the parent.
--
-- REHEARSED, not reasoned: run against a probe database holding rows on both sides of the
-- boundary (10 legacy + 4 in daily partitions), it returned a plain table with all 14 rows,
-- a queryable activity_view, and the memex_app grant intact.
--
-- LOCKS: same discipline as 0142 and for the same reason — both taken up front in the
-- emission path's order (test_events, then test_event_latest), bounded by lock_timeout, so
-- this can fail fast but never deadlock against live traffic. That is spec-398 migration
-- 0111's lesson (std-39 cl-9) and it applies just as much on the way back.

-- ⚠ THE LOCK LIVES INSIDE THE DO BLOCK, and this is not style. Operators run this file with
-- `psql -f`, which is AUTOCOMMIT: a bare `LOCK TABLE` there fails outright with "can only be
-- used in transaction blocks", and a bare `SET LOCAL` silently does nothing. A DO block runs
-- its body in an implicit transaction, so both hold. 0142 carries the same note for the same
-- reason — the first draft of this file got it wrong and was caught by running the file
-- rather than the statements.
DO $$
DECLARE view_def text;
BEGIN
  SET LOCAL lock_timeout = '10s';
  LOCK TABLE test_events, test_event_latest IN ACCESS EXCLUSIVE MODE;

  -- activity_view depends on test_events and would follow the rename to the wrong relation.
  -- Captured and replayed rather than re-typed, so a rollback cannot ship a stale copy of a
  -- view that has been edited since.
  SELECT pg_get_viewdef('activity_view'::regclass, true) INTO view_def;
  DROP VIEW activity_view;

  -- Detach FIRST. While attached, legacy's range bound rejects any post-cutover row.
  ALTER TABLE test_events DETACH PARTITION test_events_legacy;

  -- Carry every emission written since the cutover back in. Nothing is discarded.
  INSERT INTO test_events_legacy SELECT * FROM test_events;

  DROP TABLE test_events;                      -- takes the daily partitions with it
  ALTER TABLE test_events_legacy RENAME TO test_events;

  -- Give the canonical names back to the indexes the partitioned parent had claimed.
  ALTER INDEX test_events_legacy_retention_idx       RENAME TO test_events_retention_idx;
  ALTER INDEX test_events_legacy_memex_created_idx   RENAME TO test_events_memex_id_created_at_idx;
  ALTER INDEX test_events_legacy_created_at_idx      RENAME TO test_events_created_at_idx;
  ALTER INDEX test_events_legacy_subject_created_idx RENAME TO test_events_ac_uid_created_at_idx;
  ALTER INDEX test_events_legacy_test_ident_idx      RENAME TO test_events_test_identifier_idx;

  -- The PK stays (id, created_at). Narrowing it back to (id) buys nothing — no query looks
  -- a test_event up by id alone — and would mean rebuilding a unique index on the whole
  -- table inside this lock.
  GRANT SELECT, INSERT, UPDATE, DELETE ON test_events TO memex_app;
  EXECUTE format('CREATE VIEW activity_view WITH (security_invoker = true) AS %s', view_def);
END $$;
