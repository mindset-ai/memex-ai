-- spec-563 t-2 (dec-1) — the activity footer's SPEC filter gets an index to stand on.
--
-- THE DEFECT. `listActivityView(memexId, { specRef })` reads activity_view with two
-- predicates. `memex_id` pushes down — it is a base column on test_events, indexed since
-- spec-398's 0111. `spec_ref` does NOT: for the test_events arm `spec_ref` IS
-- `spec_doc.id`, and the only link back to the table is
--
--     substring(te.subject_ref from 'specs/([^/]+)/') = spec_doc.handle
--
-- with nothing indexed on that expression. So Postgres builds a hash join whose PROBE SIDE
-- is the tenant's entire test_events history, then discards everything that is not the
-- requested Spec. Measured on prod 2026-09-11 for mindset-four: 4 155 275 rows read to
-- return 0 rows, 9 343 ms of a 9 347 ms query — for a Spec that owns no test events at all.
-- The worst case in pg_stat_statements is 109 734 ms (the same plan, cold cache).
--
-- ⚠ WHAT THIS IS *NOT* FIXING. Earlier drafts of spec-563 blamed the TENANT filter. That
-- was true of 0089 and has not been true since 0109/0111 — `te.memex_id` is a base column
-- and is indexed. The sequential scan visible in the prod plan serves that tenant filter
-- and is a defensible choice (the largest tenant owns ~73 % of the loaded partitions).
-- Nothing here touches it. See spec-564's SUPERSEDED markers.
--
-- ── WHY dec-1 CHOSE AN INDEX OVER A COLUMN ──────────────────────────────────────────────
--
-- A stored generated column or a write-path `spec_doc_id` would be a cleaner end state.
-- Both REWRITE or re-plumb a table taking ~31 events/s from a client with a 5 s timeout
-- that NEVER retries (std-48) — a blocked write there is DISCARDED, not delayed. 0111 did
-- exactly that shape and deadlocked a prod deploy (40P01, std-39 cl-9). An index touches
-- neither the table's rows nor the write path, and `DROP INDEX` undoes it in one
-- statement. Both alternatives remain available if this proves insufficient; the reverse
-- would not have been true.
--
-- ── THE EXPRESSION IS COPIED FROM THE LIVE CATALOGUE ────────────────────────────────────
--
-- `pg_get_viewdef('activity_view'::regclass, true)` emits
-- `"substring"(te.subject_ref, 'specs/([^/]+)/'::text)`. An expression index is matched
-- STRUCTURALLY: if the view's spelling and this one ever diverge, the index is silently
-- never chosen — no error, no log line, no failing migration, just the old plan and the
-- old latency. The durable guard against that is the regression test
-- (services/activity-view-spec-filter.spec-563.integration.test.ts, spec-563 ac-8), which
-- asserts the ROW COUNT entering the arm. The assertion at the foot of this file guards
-- only THIS deploy — it cannot see a divergence introduced afterwards.
--
-- ── RELATIONSHIP TO out-of-band/0145 ────────────────────────────────────────────────────
--
-- 0145 builds this index CONCURRENTLY, partition by partition, so production never pays
-- for the build in a blocking window. It is an OPTIMISATION, not a prerequisite: this file
-- is self-sufficient. Every fresh database (per-worker test DBs, the e2e cold-template
-- build, a new dev machine) applies migrations through a runner whose readdirSync never
-- sees out-of-band/, and depending on a prep file made `pnpm db:migrate` fail everywhere
-- except prod once already (0142's header). On prod the index already exists and IF NOT
-- EXISTS skips it; on a fresh database the table is empty and the build is instant.
--
-- ⚠ IF NOT EXISTS MATCHES ON THE NAME ALONE. 0142 records the near-miss: the name was
-- already taken by a renamed legacy index, the statement silently created NOTHING, and a
-- scrolled-past NOTICE was the only evidence. Here the collision is intended (0145 creates
-- the same name on purpose) — so the skip is correct, and the risk moves to skipping over
-- the WRONG index. §2 turns that from a silent success into a failed deploy.

-- ── 1. The index ────────────────────────────────────────────────────────────────────────
-- On the partitioned PARENT, so it reaches every existing partition and every partition
-- test-event-retention.ts mints on its 60-day horizon. That propagation is the point
-- (0142's header records what a missing forward index costs) and it is also the cost:
-- one more tuple per insert on every partition, permanently [per std-39 cl-7].
CREATE INDEX IF NOT EXISTS test_events_memex_spec_handle_created_idx
  ON test_events (memex_id, substring(subject_ref, 'specs/([^/]+)/'), created_at);
--> statement-breakpoint

-- ── 2. Assert what §1 left behind — never trust a skip ──────────────────────────────────
DO $$
DECLARE
  idx_oid    oid;
  idx_valid  boolean;
  idx_def    text;
  view_def   text;
BEGIN
  SELECT c.oid, i.indisvalid, pg_get_indexdef(c.oid)
    INTO idx_oid, idx_valid, idx_def
    FROM pg_class c
    JOIN pg_index i ON i.indexrelid = c.oid
   WHERE c.relname = 'test_events_memex_spec_handle_created_idx';

  IF idx_oid IS NULL THEN
    RAISE EXCEPTION
      'spec-563: test_events_memex_spec_handle_created_idx does not exist after CREATE INDEX. '
      'The statement was skipped or failed silently.';
  END IF;

  -- An interrupted 0145 leaves the parent index INVALID (not every partition attached).
  -- The planner ignores an invalid index, so the deploy would "succeed" and change nothing.
  IF NOT idx_valid THEN
    RAISE EXCEPTION
      'spec-563: test_events_memex_spec_handle_created_idx exists but is INVALID — a '
      'partition build from out-of-band/0145 failed or is unattached. The planner will '
      'ignore it. Re-run 0145 and confirm indisvalid before deploying.';
  END IF;

  -- IF NOT EXISTS matched on the name; confirm the name holds the index we meant.
  IF idx_def NOT LIKE '%memex_id%' OR idx_def NOT LIKE '%specs/([^/]+)/%' THEN
    RAISE EXCEPTION
      'spec-563: the index name is taken by something else: %', idx_def;
  END IF;

  -- The coupling this whole change rests on. Guards this deploy only — a divergence
  -- introduced later is caught by the regression test, not here.
  SELECT pg_get_viewdef('activity_view'::regclass, true) INTO view_def;
  IF view_def NOT LIKE '%specs/([^/]+)/%' THEN
    RAISE EXCEPTION
      'spec-563: activity_view no longer contains the substring pattern this index is '
      'built on. The index would never be chosen. Re-derive the expression from '
      'pg_get_viewdef and rebuild.';
  END IF;
END $$;
