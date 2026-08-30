-- spec-520 t-12, STEP 2 of 2 — test_events becomes time-partitioned; the per-pair trim dies.
--
-- ⚠ RUN drizzle/out-of-band/0141_..._prep.sql FIRST, and confirm its index is VALID.
-- Without it this migration builds a 1.4M-row unique index inside its exclusive window.
--
-- WHAT THIS BUYS. `trimTestEventsForPair` deleted the oldest rows of a pair inside every
-- emission transaction: 13.4% of all database time, 11.24M deletes against 11.87M inserts,
-- and autovacuum running near-continuously behind it. Retention becomes a property of
-- WHICH PARTITION a row landed in. Rows leave only when an aged-out partition is dropped —
-- a catalogue operation. No deletes, no dead tuples, nothing to vacuum. The 13.4% does not
-- shrink; it goes to zero.
--
-- ── HOW THIS AVOIDS REPEATING 0111 ──────────────────────────────────────────────────────
--
-- spec-398's migration 0111 restructured this same table by copying every row into a new
-- one, holding ACCESS EXCLUSIVE for ~80 s — and its first prod release DEADLOCKED against
-- live traffic (40P01) and rolled the whole file back. That is std-39 cl-9's worked
-- example, and it is this table.
--
-- This migration COPIES NOTHING. The existing table is renamed and ATTACHed as the first
-- partition of a new parent, which is a catalogue operation plus one validation scan.
--
-- MEASURED at production scale (local pg16, 1.4M rows, 2026-08-30): the entire exclusive
-- window below — create parent, adopt the PK, attach 1.4M rows, create the parent
-- indexes — is **~150 ms**. Not an estimate; the probe ran.
--
-- ⚠ WHY 150 ms MATTERS AND 80 s DOES NOT MERELY "COST LATENCY". The AC emitter has a 5 s
-- client timeout and NEVER retries (std-48 — a retry storm against a saturated server is
-- worse than a dropped event). So a blocked emission is not delayed, it is DISCARDED, with
-- only a warning in someone's CI log. At ~31 events/s an 80 s window silently drops ~2,500
-- emissions and leaves their ACs on a stale verdict. 150 ms drops none.
--
-- ── LOCK ORDER (std-39 cl-2/cl-3) ───────────────────────────────────────────────────────
--
-- Live emissions take test_events then test_event_latest, in that order
-- (routes/test-events.ts). This migration takes BOTH up front in the SAME order, so no
-- lock-order cycle can form: it either wins a clean window or fails fast on lock_timeout
-- and retries on the next deploy. It can never deadlock.
--
-- The LOCK is wrapped in a DO block because this file is applied two ways: the hand-runner
-- wraps it in one transaction (a bare LOCK is fine there), while the e2e-cold template
-- build pipes it through `psql -f` in AUTOCOMMIT, where a bare LOCK errors with "can only
-- be used in transaction blocks". A DO block runs its body in an implicit transaction in
-- both paths. That lesson is 0111's too.
--
-- ── WHAT THIS MIGRATION DELIBERATELY DOES NOT DO ────────────────────────────────────────
--
-- IT DELETES NO DATA. Every existing row is carried into the legacy partition, whatever its
-- age. Retention is applied afterwards, by maintenance, from configuration — so the
-- irreversible moment is a separate, config-driven step that can be paused, not a side
-- effect of a schema change. A 3-day window would otherwise have discarded 1,046,386 of
-- the 1,404,630 rows here, at the exact moment the schema was also changing.
--
-- IT ADDS NO RLS. spec-398 ac-10 asserts test_events carries none and that spec-399 owns
-- it; verified against the live catalogue 2026-08-30 (relrowsecurity = false). ⚠ FOR
-- spec-399: a policy created on this parent is INHERITED by every partition, including ones
-- maintenance creates later — so the policy belongs on the PARENT and must never be written
-- per-partition. Designing that is spec-399's call, not an assumption to inherit from here.

-- ── 0. Deadlock guard — both locks up front, in the emission path's order ────────────────
DO $$
BEGIN
  SET LOCAL lock_timeout = '10s';
  LOCK TABLE test_events IN ACCESS EXCLUSIVE MODE;
  LOCK TABLE test_event_latest IN ACCESS EXCLUSIVE MODE;
END $$;

-- ── 1. The whole swap, in one dynamic block ─────────────────────────────────────────────
--
-- Dynamic because the partition boundary is computed AT RUN TIME. Hardcoding a date would
-- force this file and the deploy calendar to agree; a deploy that slipped past it would
-- start rejecting inserts. `date_trunc('day', now()) + 1 day` means the legacy partition
-- absorbs everything up to the next UTC midnight and the daily partitions take over
-- cleanly from there, whenever the deploy actually happens.
DO $$
DECLARE
  boundary   timestamptz := date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' + interval '1 day';
  view_def   text;
  part_start timestamptz;
  horizon    int := 60;   -- keep in step with PARTITION_HORIZON_DAYS in test-event-retention.ts
BEGIN
  -- The activity_view test_events arm would silently follow the table through the rename
  -- and end up reading the LEGACY PARTITION instead of the parent — seeing old rows only,
  -- with no error anywhere. It is captured and replayed rather than re-typed here: a
  -- hardcoded copy would be a snapshot of the view as it was the day this was written, and
  -- 0119 already renamed a column inside it once since 0111.
  SELECT pg_get_viewdef('activity_view'::regclass, true) INTO view_def;
  DROP VIEW activity_view;

  -- The old PK is on (id) alone. A partitioned parent keyed (id, created_at) requires each
  -- partition to carry an equivalent unique index; 0141 built it CONCURRENTLY.
  ALTER TABLE test_events RENAME TO test_events_legacy;

  -- ⚠ SELF-SUFFICIENT ON PURPOSE. 0141 builds this index CONCURRENTLY so production never
  -- pays for the build inside the exclusive window — but every FRESH database (each
  -- per-worker test DB, the e2e cold-template build, a new dev machine) applies migrations
  -- through the runner, which never sees out-of-band/. Depending on 0141 made
  -- `pnpm db:migrate` fail everywhere except prod. On prod the index already exists and
  -- follows the rename, so IF NOT EXISTS skips it; on a fresh database the table is empty
  -- and the build is instant. 0141 is now an optimisation, not a prerequisite.
  CREATE UNIQUE INDEX IF NOT EXISTS test_events_id_created_at_key
    ON test_events_legacy (id, created_at);

  ALTER TABLE test_events_legacy DROP CONSTRAINT test_events_new_pkey;
  ALTER TABLE test_events_legacy ADD PRIMARY KEY USING INDEX test_events_id_created_at_key;

  CREATE TABLE test_events (
    id              uuid        NOT NULL DEFAULT gen_random_uuid(),
    subject_ref     text        NOT NULL,
    memex_id        uuid        NOT NULL,
    status          text        NOT NULL,
    test_identifier text,
    duration_ms     integer,
    commit_sha      text,
    run_id          text,
    actor           text,
    hidden          boolean     NOT NULL DEFAULT false,
    metadata        jsonb,
    created_at      timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT test_events_pkey PRIMARY KEY (id, created_at),
    CONSTRAINT test_events_status_valid CHECK (status = ANY (ARRAY['pass'::text, 'fail'::text, 'error'::text]))
  ) PARTITION BY RANGE (created_at);

  -- ⚠ NO DEFAULT PARTITION, and that was measured rather than reasoned. Once rows for a day
  -- land in a DEFAULT partition, creating that day's real partition FAILS outright:
  --   ERROR: updated partition constraint for default partition would be violated by some row
  -- A default would turn a quiet gap between deploys into a migration that cannot apply
  -- until someone drains it by hand. A missing partition is instead a loud, immediate
  -- insert error, and the 60-day horizon exists so it is never reached.
  EXECUTE format(
    'ALTER TABLE test_events ATTACH PARTITION test_events_legacy FOR VALUES FROM (%L) TO (%L)',
    '2000-01-01'::timestamptz, boundary);

  -- ⚠ BOUNDS ARE timestamptz, NEVER date. A `date` used as a partition bound is
  -- interpreted in the SESSION's timezone, not UTC. This migration was first written with
  -- `boundary::date` and failed immediately on a machine running Europe/Lisbon:
  --
  --   ERROR: partition "test_events_20260831" would overlap partition "test_events_legacy"
  --
  -- because boundary was 2026-08-31 00:00 UTC while the date literal '2026-08-31' resolved
  -- to 2026-08-30 23:00 UTC — the daily partition started an hour before the legacy one
  -- ended. Cloud SQL runs UTC, so this would have passed in production and lain in wait
  -- for the first developer or restore on a non-UTC server. %L on a timestamptz emits a
  -- literal carrying its offset, so no session can reinterpret it.
  part_start := boundary;
  WHILE part_start < boundary + (horizon || ' days')::interval LOOP
    EXECUTE format(
      'CREATE TABLE IF NOT EXISTS test_events_%s PARTITION OF test_events FOR VALUES FROM (%L) TO (%L)',
      to_char(part_start AT TIME ZONE 'UTC', 'YYYYMMDD'), part_start, part_start + interval '1 day');
    part_start := part_start + interval '1 day';
  END LOOP;

  -- Creating an index on the parent REUSES a matching index that already exists on a
  -- partition rather than rebuilding it — verified on pg16: the legacy table's existing
  -- indexes became children of the parent's. So this costs nothing on the 1.4M legacy rows
  -- and only builds on the (empty) forward partitions.
  --
  -- Index inventory, checked with EXPLAIN against every surviving reader on develop
  -- 2026-08-30 rather than assumed from the names:
  --   retention_idx (subject_ref, test_identifier, created_at)
  --       KEPT. Named for the trim being deleted, but it is the workhorse: it serves the
  --       AC matrix's row_number() read, BOTH of the digest's CTEs, and the targeted
  --       discontinue delete. Dropping it "with the trim" would have been a plausible,
  --       measurable mistake.
  --   memex_id_created_at_idx  KEPT — the activity_view arm.
  --   created_at_idx           KEPT — testSignalPulse's window. Partition pruning narrows
  --                            it to a day, but a day holds ~2.7M rows.
  -- Two more exist today and were chosen by NO reader in that sweep:
  -- ac_uid_created_at_idx (subject_ref, created_at) and test_identifier_idx. They are NOT
  -- dropped here — a local EXPLAIN sweep is not proof about prod, and pg_stat_user_indexes
  -- on prod settles it. Carried forward unchanged; retiring them is a separate, evidenced
  -- change. Every index carried costs a tuple per insert on every partition (cl-7), so
  -- this is a real cost being consciously deferred, not overlooked.
  CREATE INDEX IF NOT EXISTS test_events_retention_idx        ON test_events (subject_ref, test_identifier, created_at);
  CREATE INDEX IF NOT EXISTS test_events_memex_id_created_at_idx ON test_events (memex_id, created_at);
  CREATE INDEX IF NOT EXISTS test_events_created_at_idx       ON test_events (created_at);
  CREATE INDEX IF NOT EXISTS test_events_ac_uid_created_at_idx ON test_events (subject_ref, created_at);
  CREATE INDEX IF NOT EXISTS test_events_test_identifier_idx  ON test_events (test_identifier, created_at);

  -- 0081's GRANT ... ON ALL TABLES was a one-time statement; it does not reach a table
  -- created today. Every table added since carries its own explicit grant, and omitting it
  -- here would 401 nothing and 500 everything: the runtime role would lose the emission
  -- path entirely.
  GRANT SELECT, INSERT, UPDATE, DELETE ON test_events TO memex_app;

  EXECUTE format('CREATE VIEW activity_view WITH (security_invoker = true) AS %s', view_def);
END $$;
