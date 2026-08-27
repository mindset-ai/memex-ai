-- spec-520 t-9 (ac-22) + issue-8 — row-level security on the per-day rollup.
--
-- SPLIT FROM 0134 DELIBERATELY, and the split is the point. 0134 created the
-- table and explicitly did NOT enable RLS, because at that moment the emission
-- path could not have satisfied a policy: `routes/test-events.ts` opened its
-- write transaction with no `runWithMemexId` on the async stack, and `mutate()`
-- establishes none. This migration ships in the SAME change as the wrap that
-- fixes that (s-2 Trap 2: "before or WITH the RLS migration, never after").
--
-- WHY THAT ORDER IS NOT PEDANTRY. Every tenant policy in this directory carries
-- an explicit `nullif(current_setting('app.memex_id', true), '') IS NOT NULL`
-- conjunct, which makes the predicate FALSE — not NULL — when the GUC is unset.
-- For SELECT and UPDATE that filters to zero rows, silently. For INSERT it
-- raises "new row violates row-level security policy". The rollup write is an
-- upsert, so it takes the INSERT path, inside the same transaction as the
-- test_events insert, which mutate() rethrows. RLS here without the wrap does
-- not lose rollup rows quietly — it 500s EVERY emission in production, while dev
-- and CI stay green because the owner role bypasses RLS.
--
-- That is not a prediction: `test-events-tenant-context.rls-restricted.test.ts`
-- drove it red→green under the real `memex_app` role. Red = the emission POST
-- returns 500 with this migration applied and the wrap absent.
--
-- ENABLE, NEVER FORCE [per std-36]. FORCE would apply RLS to the table OWNER
-- too, and on Cloud SQL the migration/deploy role is `postgres`, which is not a
-- real superuser and lacks BYPASSRLS — under FORCE every migration and admin
-- query against this table would be filtered to nothing. 0081 shipped FORCE and
-- 0093 had to undo it; std-36 exists because of that incident. The dynamic guard
-- in db/spec-199-rls-schema.test.ts fails CI on any forced tenant table.
--
-- The policy predicate is byte-identical to every other tenant table's on
-- purpose. A table whose isolation reads differently is a table someone has to
-- reason about separately, and this one has no reason to be special.

ALTER TABLE test_run_daily ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS test_run_daily_memex_isolation ON test_run_daily;
CREATE POLICY test_run_daily_memex_isolation ON test_run_daily
  USING (
    nullif(current_setting('app.memex_id', true), '') IS NOT NULL
    AND memex_id = current_setting('app.memex_id', true)::uuid
  )
  WITH CHECK (
    nullif(current_setting('app.memex_id', true), '') IS NOT NULL
    AND memex_id = current_setting('app.memex_id', true)::uuid
  );

-- The schema-wide DEFAULT PRIVILEGES from 0081 should already cover a new table,
-- but state it explicitly rather than relying on a default set four years of
-- migrations ago: a missing grant here fails as "permission denied for table",
-- which reads like an RLS problem and is not one.
GRANT SELECT, INSERT, UPDATE, DELETE ON test_run_daily TO memex_app;
