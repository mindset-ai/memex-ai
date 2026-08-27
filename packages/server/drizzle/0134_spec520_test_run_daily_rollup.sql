-- spec-520 t-9 (dec-5, ac-21/ac-26) — the per-day test-run rollup.
--
-- WHY A NEW TABLE AND NOT A BETTER QUERY. The two history consumers
-- (testRunVolume, listAcAlignmentOverTime) read raw `test_events`, which the
-- retention trim caps at RETENTION_KEEP=10 rows per (subject_ref,
-- test_identifier) pair. So they count rows that were already deleted. Measured
-- on prod 2026-08-18: the summary tier declares 23,718,476 runs while 1,072,186
-- raw rows survive — the charts see 4.5%. And the loss is NOT uniform: 65,708
-- pairs sit at exactly 10 surviving rows, the trim's ceiling made visible, so
-- the busier an AC the shorter its visible history. A "test run volume over
-- time" chart that under-counts hardest where there is most activity inverts the
-- story it exists to tell. No index fixes that; the rows are gone.
--
-- THE GRAIN, DECLARED (dec-5, spec-125's rule): one row per test, per subject,
-- per UTC day, carrying how many times it ran and how many times it passed,
-- failed or errored. The finest of three candidate grains, chosen because
-- compression is already large at this grain and it is the only one that
-- preserves WHICH test went red and lets AC-green be derived properly.
--
-- THIS RETIRES TWO WRITES RATHER THAN ADDING A THIRD. Counting at write time
-- makes the per-pair count retention unnecessary (t-12 deletes the trim, 12.6%
-- of all DB time) and makes ac_first_verified redundant (t-10 folds it in, 6.1%)
-- — that table exists ONLY because retention destroyed the first-green date, the
-- same lesson this Spec is now learning once instead of per-metric. Net: fewer
-- statements per emission than today, and no delete churn at all.
--
-- memex_id IS FIRST-CLASS [per std-32], stamped at write, never parsed back out
-- of subject_ref at read time. That parse is the spec-396 leak pattern — a real
-- cross-org bleed of ~1.5M rows across 137 memexes — and it is also why
-- ac_first_verified (subject_ref PK, no tenancy column) can never carry an RLS
-- policy. Folding it into a table that does is a security gain of dec-5, not a
-- side effect.
--
-- NO INDEX ON THE COUNT COLUMNS, deliberately [per std-39 cl-7]. These are hot
-- counter rows: at ~227k events/day across this key, roughly ten updates per row
-- per day. HOT updates apply only while no indexed column changes, so an index
-- on a count would make every increment write an index tuple too and hand
-- autovacuum the dead tuples to chase. If a chart needs speed, aggregate on the
-- key columns — do not index a counter.
--
-- THE CHECK IS A WIRING TRIPWIRE, not a business rule. Every emission
-- increments run_count and exactly one outcome count, so run_count = pass + fail
-- + error is an invariant of correct code. A violation means the increment logic
-- is wrong, and the CHECK says so on the first bad write instead of in a chart
-- weeks later. A CHECK is not an index, so HOT still applies.
--
-- ⚠ NO ROW LEVEL SECURITY IN THIS MIGRATION, AND THAT IS NOT AN OVERSIGHT.
-- std-36 requires an ENABLE + memex_id isolation policy on every tenancy-scoped
-- table, and t-9 ac-3 demands it. It is deliberately deferred to a follow-up
-- migration gated on spec-520 issue-8, because the prerequisite is missing:
--
--   `routes/test-events.ts` opens its write transaction (the db.transaction
--   inside mutate(), around :492) with NO runWithMemexId on the async stack —
--   runWithMemexId appears exactly once in that file, at :563, around the
--   auto-resolve READ only. mutate() itself establishes no tenant context.
--
-- Every tenant policy in this directory carries an explicit
-- `nullif(current_setting('app.memex_id', true), '') IS NOT NULL` conjunct,
-- which makes the predicate FALSE (not NULL) when the GUC is unset. For SELECT
-- and UPDATE that filters to zero rows — silent. For INSERT it raises "new row
-- violates row-level security policy" — a hard error, inside the same
-- transaction as the test_events insert, which mutate() rethrows. So enabling
-- RLS here before the write is wrapped would 500 EVERY emission in production
-- while dev and CI stayed green, because the owner role bypasses RLS
-- (std-36: ENABLE, never FORCE).
--
-- Do not add the policy to this file. Close issue-8 first.
--
-- LOCK ORDER. The rollup upsert is taken immediately after the
-- test_event_latest upsert and before the retention trim, i.e. the same relative
-- position on every emission. Restructuring a continuously-written table in this
-- path is what deadlocked and rolled back a prod deploy during spec-398
-- (std-39 cl-9), and a consistent order is what prevents the repeat. CREATE
-- TABLE takes no lock on anything the emission path touches, so this migration
-- itself is not the risky one — t-12's partitioning is.

CREATE TABLE IF NOT EXISTS test_run_daily (
  memex_id        uuid    NOT NULL,
  subject_ref     text    NOT NULL,
  test_identifier text    NOT NULL DEFAULT '',
  day             date    NOT NULL,
  run_count       integer NOT NULL DEFAULT 0,
  pass_count      integer NOT NULL DEFAULT 0,
  fail_count      integer NOT NULL DEFAULT 0,
  error_count     integer NOT NULL DEFAULT 0,
  CONSTRAINT test_run_daily_pkey
    PRIMARY KEY (memex_id, subject_ref, test_identifier, day),
  CONSTRAINT test_run_daily_counts_sum
    CHECK (run_count = pass_count + fail_count + error_count)
);

-- The PK covers (memex_id, subject_ref, test_identifier, day), so a per-tenant
-- day-range scan — what both history charts do — rides its leading columns.
-- No further index is added: none is needed for the known consumers, and every
-- extra index is another tuple written on each of ~227k daily increments.
