-- spec-563 t-2 — OUT OF BAND. An OPTIMISATION for production, not a prerequisite.
--
-- ⚠ DELIBERATELY OUTSIDE THE MIGRATION RUNNER. apply-hand-migrations.mjs wraps every file
-- in one transaction, and CREATE INDEX CONCURRENTLY cannot run inside a transaction block.
-- Same posture as 0138 and 0141. The runner's readdirSync is non-recursive, so a file in
-- out-of-band/ is never picked up automatically.
--
-- ⚠ 0146 DOES NOT DEPEND ON THIS FILE. It creates the same parent index itself, because
-- every fresh database — each per-worker test DB, the e2e cold-template build, a new dev
-- machine — applies migrations through a runner that never sees out-of-band/. Depending on
-- a prep file made `pnpm db:migrate` fail everywhere except prod once already (0142's
-- header records it). Running this first is what keeps PRODUCTION's build out of a
-- blocking window; skipping it does not break anything.
--
-- WHAT IT BUILDS. An expression index that lets the activity footer's SPEC filter reach
-- test_events:
--
--     (memex_id, substring(subject_ref, 'specs/([^/]+)/'), created_at)
--
-- Today `spec_ref` cannot push down — activity_view's test_events arm links back through
-- `substring(te.subject_ref, …) = spec_doc.handle` with nothing indexed on that expression,
-- so the hash join's probe side is the tenant's WHOLE history. Measured on prod
-- 2026-09-11: 4 155 275 rows read to return 0, 9 343 ms of a 9 347 ms query.
--
-- ⚠ THE EXPRESSION IS COPIED FROM THE LIVE CATALOGUE, NOT FROM A MIGRATION FILE.
-- `pg_get_viewdef('activity_view'::regclass, true)` on prod emits
-- `"substring"(te.subject_ref, 'specs/([^/]+)/'::text)`. An index whose expression differs
-- by so much as an argument form is simply never chosen — no error, no failing test, just
-- the old plan back. That is precisely why spec-564 now stamps a SUPERSEDED marker on the
-- migrations that define this view: reading one of them instead of the catalogue is the
-- authoring error that produced spec-563's first, wrong mechanism.
--
-- ── WHY THIS IS NOT ONE STATEMENT ───────────────────────────────────────────────────────
--
-- test_events is PARTITIONED (0142). `CREATE INDEX CONCURRENTLY` is REFUSED on a
-- partitioned parent:
--     ERROR: cannot create index on partitioned table "test_events" concurrently
-- So the build follows Postgres's documented three-step form:
--   1. create the parent index ON ONLY — a catalogue entry, marked INVALID, no partition
--      work, brief lock;
--   2. build each partition's index CONCURRENTLY — no writes blocked anywhere;
--   3. ATTACH each one. When the last partition is attached the parent index becomes
--      VALID automatically.
-- Until step 3 completes for EVERY partition the parent index stays invalid and the
-- planner ignores it. An interrupted run is therefore safe but useless — re-run it.
--
-- RUN IT LIKE THIS (int first, then prod), with the deploy proxy up. \gexec is what makes
-- the per-partition statements run one-per-transaction in psql's autocommit:
--
--     psql "$DB_URL" -f packages/server/drizzle/out-of-band/0145_spec563_activity_footer_index_prep.sql
--
-- THEN CONFIRM IT IS VALID before deploying 0146 — see the verification query at the end.
-- A CONCURRENTLY build that fails leaves an INVALID index behind, which nothing will use
-- and nothing will complain about. 0146 asserts this rather than trusting it.

-- ⚠ ON_ERROR_STOP IS LOAD-BEARING, NOT HOUSEKEEPING. psql's DEFAULT is to keep going after
-- an error, so without this the §0 guard below RAISES, is ignored, and the script cheerfully
-- builds the orphan indexes it just refused to build. Measured: the first version of that
-- guard printed its refusal and then created duplicates anyway.
\set ON_ERROR_STOP on

-- ── 0. ⚠ REFUSE TO RUN AFTER 0146. THIS ORDER IS NOT ADVICE. ────────────────────────────
--
-- MEASURED, not reasoned: this file was run against a database where 0146 had already
-- created the parent index, to find out what happens. It is worse than a no-op.
--
-- `CREATE INDEX ... ON test_events` (0146, on the PARENT) automatically creates and
-- ATTACHES an index on all 61 partitions. Running this file afterwards then:
--   • skips §1 with a NOTICE (the parent name is taken),
--   • SUCCEEDS at all 61 CONCURRENT per-partition builds — they use different names,
--   • and FAILS every ATTACH with
--       ERROR: cannot attach index "test_events_2026MMDD_mx_spec_created_idx" ...
--       DETAIL: Another index is already attached for partition "test_events_2026MMDD".
--
-- The failures are the loud part. The damage is the quiet part: 61 orphan duplicate
-- indexes are left behind, attached to nothing, each costing a tuple per insert forever on
-- the hottest table in the system, serving no reader. psql keeps going after an error in a
-- non-transactional script, so the operator sees a wall of red and a database that is
-- worse than before.
--
-- This block makes that unreachable.
DO $$
DECLARE attached int;
BEGIN
  SELECT count(*) INTO attached
    FROM pg_inherits pi
    JOIN pg_class parent ON parent.oid = pi.inhparent
   WHERE parent.relname = 'test_events_memex_spec_handle_created_idx';

  IF attached > 0 THEN
    RAISE EXCEPTION
      'spec-563: 0146 has ALREADY run here — the parent index exists with % partition '
      'indexes attached. This file is a PRE-deploy step only. Running it now would build '
      '% orphan duplicate indexes that can never attach and would never be used. Nothing '
      'to do: the index is already in place.', attached, attached;
  END IF;
END $$;
--> only meaningful under psql; the runner never sees this file.

-- ── 1. The parent index, ON ONLY — invalid until every partition is attached ────────────
CREATE INDEX IF NOT EXISTS test_events_memex_spec_handle_created_idx
  ON ONLY test_events (memex_id, substring(subject_ref, 'specs/([^/]+)/'), created_at);

-- ── 2. One CONCURRENT build per partition ───────────────────────────────────────────────
SELECT format(
         'CREATE INDEX CONCURRENTLY IF NOT EXISTS %I ON %I.%I (memex_id, substring(subject_ref, %L), created_at)',
         left(c.relname, 39) || '_mx_spec_created_idx',
         n.nspname, c.relname,
         'specs/([^/]+)/')
  FROM pg_inherits i
  JOIN pg_class c     ON c.oid = i.inhrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE i.inhparent = 'test_events'::regclass
 ORDER BY c.relname
\gexec

-- ── 3. Attach each partition index to the parent ────────────────────────────────────────
-- ALTER INDEX … ATTACH PARTITION is a catalogue operation. It is skipped for any partition
-- whose index is already attached, so re-running this file is safe.
SELECT format(
         'ALTER INDEX test_events_memex_spec_handle_created_idx ATTACH PARTITION %I.%I',
         n.nspname, left(c.relname, 39) || '_mx_spec_created_idx')
  FROM pg_inherits i
  JOIN pg_class c     ON c.oid = i.inhrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE i.inhparent = 'test_events'::regclass
 ORDER BY c.relname
\gexec

-- ── 4. VERIFY — do not skip this, and do not read a NOTICE as a result ──────────────────
-- indisvalid must be true. If it is false, at least one partition's CONCURRENT build
-- failed or is unattached; find it, drop its index, and run this file again:
--
--   DROP INDEX CONCURRENTLY <partition>_mx_spec_created_idx;
--
SELECT c.relname                                     AS index_name,
       i.indisvalid                                  AS is_valid,
       (SELECT count(*) FROM pg_inherits WHERE inhparent = 'test_events'::regclass) AS partitions,
       (SELECT count(*) FROM pg_index pi
          JOIN pg_inherits pii ON pii.inhrelid = pi.indexrelid
         WHERE pii.inhparent = c.oid)                AS attached_indexes
  FROM pg_index i
  JOIN pg_class c ON c.oid = i.indexrelid
 WHERE c.relname = 'test_events_memex_spec_handle_created_idx';
