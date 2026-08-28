-- spec-520 dec-7 option C (ac-23 amended) — give ac_first_verified the tenancy column it
-- has never had, so it can be isolated like every other tenant table.
--
-- WHY THE TABLE STAYS. t-10 planned to fold this into the per-day rollup and drop it. It
-- cannot be folded: the fact is per (memex_id, subject_ref) — "when did this subject first
-- go green" — while the rollup's grain is (memex_id, subject_ref, test_identifier, day).
-- Storing a date at a finer grain than it has forces either a sentinel row with an invented
-- test_identifier and day, or the date duplicated across every row for that subject and
-- rewritten daily. Both are worse than a second small table. dec-7 has the full reasoning.
--
-- WHAT WAS ACTUALLY WRONG WITH IT — and it is not the storage, it is the tenancy.
-- `ac_first_verified` is subject_ref PK + first_verified_at, with NO memex_id at all. So it
-- cannot carry an RLS policy even once spec-399 lands, and its only reader (acsOverTime's
-- first_pass CTE, services/analytics.ts) scopes by `subject_ref LIKE 'ns/mx/%'` — tenancy
-- carried by a STRING. That is the spec-396 leak pattern: a real cross-org bleed of ~1.5M
-- rows across 137 memexes, whose fix was to stop parsing tenancy out of ref strings at read
-- time. This table never adopted it. That is what this migration closes.
--
-- NO DATA MOVES. Every existing row stays exactly where it is with its date untouched —
-- which matters more here than anywhere: this table exists ONLY because retention destroyed
-- the first-green date once already, and losing it again while "improving" it would be a
-- particularly bad repeat.
--
-- memex_id IS NULLABLE, DELIBERATELY. The backfill resolves it from test_event_latest,
-- which carries memex_id for each subject_ref and is never trimmed by retention. A ref with
-- no surviving summary row — a discontinued AC, a deleted Spec — cannot be resolved, and
-- the rule from dec-7 is that such a row is ENUMERATED, never silently discarded. Leaving
-- the column nullable keeps the row and its date: under RLS a NULL memex_id matches no
-- tenant, so it is invisible to the product but fully visible to the owner role for
-- inspection. A NOT NULL here would have forced the migration to either fail or delete.
--
-- Count what is left behind after applying:
--   SELECT count(*) FROM ac_first_verified WHERE memex_id IS NULL;

ALTER TABLE ac_first_verified ADD COLUMN IF NOT EXISTS memex_id uuid;

-- Backfill from the summary tier. DISTINCT because test_event_latest is keyed
-- (subject_ref, test_identifier) — one subject can have many test identifiers, but they all
-- belong to the same memex, so any one of them answers the question.
UPDATE ac_first_verified a
   SET memex_id = l.memex_id
  FROM (SELECT DISTINCT subject_ref, memex_id FROM test_event_latest) l
 WHERE a.subject_ref = l.subject_ref
   AND a.memex_id IS NULL;

-- Index the tenancy column: the read is now `WHERE memex_id = $1` and this table is small
-- but read on every Insights page load. Cheap to add now, awkward once it is hot.
CREATE INDEX IF NOT EXISTS ac_first_verified_memex_id_idx ON ac_first_verified (memex_id);

-- ENABLE, never FORCE [per std-36]. FORCE would apply RLS to the table OWNER too, and on
-- Cloud SQL the migration/deploy role is `postgres`, which is not a real superuser and lacks
-- BYPASSRLS — under FORCE every migration and admin query here would be filtered to nothing.
-- 0081 shipped FORCE and 0093 had to undo it; the dynamic guard in
-- db/spec-199-rls-schema.test.ts fails CI on any forced tenant table.
ALTER TABLE ac_first_verified ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS ac_first_verified_memex_isolation ON ac_first_verified;
CREATE POLICY ac_first_verified_memex_isolation ON ac_first_verified
  USING (
    nullif(current_setting('app.memex_id', true), '') IS NOT NULL
    AND memex_id = current_setting('app.memex_id', true)::uuid
  )
  WITH CHECK (
    nullif(current_setting('app.memex_id', true), '') IS NOT NULL
    AND memex_id = current_setting('app.memex_id', true)::uuid
  );

-- Byte-identical to every other tenant policy on purpose. A table whose isolation reads
-- differently is a table someone has to reason about separately, and this one has no reason
-- to be special.
GRANT SELECT, INSERT, UPDATE, DELETE ON ac_first_verified TO memex_app;
