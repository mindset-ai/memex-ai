-- spec-520 issue-12 — repair the ac_first_verified rows whose NULL memex_id makes every
-- emission for them fail with a 500.
--
-- ⚠ THIS IS A LIVE PRODUCTION DEFECT, not a cleanup. Reproduced 2026-09-01:
--
--     POST /api/test-events  <a ref with a NULL-memex_id row>  → HTTP 500, twice
--     POST /api/test-events  <any other ref>                   → HTTP 201
--
--     SELECT count(*) FILTER (WHERE memex_id IS NULL), count(*) FROM ac_first_verified;
--       6,585 of 21,318  →  31% of the table
--
-- The 500 rolls back the whole emission transaction, so the test_events row is lost too,
-- and the emitter swallows non-2xx by design (std-48). Nothing reports it: the AC simply
-- keeps its previous verdict forever, which is indistinguishable from "the test did not
-- emit".
--
-- ── HOW A CORRECT DECISION PRODUCED THIS ────────────────────────────────────────────────
--
-- Migration 0136 added memex_id and an RLS policy, and left the column NULLABLE on purpose:
-- a ref whose test_event_latest row no longer existed could not be resolved at migration
-- time, and THIS TABLE EXISTS BECAUSE FIRST-GREEN DATES WERE DESTROYED ONCE ALREADY.
-- Deleting those rows to satisfy a NOT NULL would have repeated exactly the loss the table
-- was built to prevent. That call was right and stays right.
--
-- 0136 then recorded that the writer heals the NULL on the next emission —
-- `COALESCE(existing, EXCLUDED)`, never overwriting a resolved value.
--
-- ⚠ THAT HEALING CANNOT EXECUTE. Reproduced locally against a seeded NULL row, and the
-- exact error matters because a first guess got it wrong:
--
--     ERROR: new row violates row-level security policy (USING expression)
--            for table "ac_first_verified"
--
-- NOT a unique violation. The unique index finds the row and ON CONFLICT correctly routes
-- to DO UPDATE — then the policy's USING clause rejects that update, because it is
-- evaluated against the EXISTING row, whose memex_id is NULL and therefore matches no
-- tenant. The write the healing depends on is refused by the policy the healing was
-- written to satisfy. mutate() rethrows, and the emission 500s.
--
-- The repair was designed, documented, and structurally unreachable. No unit test could
-- catch it: tests create rows fresh, with a memex_id, so the NULL-row conflict never arises
-- outside data a backfill produced.
--
-- ⚠ AND THE AFFECTED POPULATION IS THE WORST ONE. A NULL memex_id means "no surviving
-- test_event_latest row at backfill time" — an AC that is untested, or whose emissions were
-- retired. Those are precisely the ACs someone is actively trying to turn green.
--
-- ── WHY THIS PARSES THE REF, HAVING SPENT THIS SPEC RETIRING THAT PATTERN ────────────────
--
-- Deriving tenancy from a subject_ref string is the spec-396 leak pattern, and spec-520
-- removed it from read paths deliberately (ac-2, ac-35, ac-37). Doing it here is not a
-- relapse, and the distinction is worth stating rather than assuming:
--
--   * This is a ONE-OFF REPAIR run by the OWNER, not a read path and not a runtime write.
--   * The resolution is the SAME one the emission path performs (`resolveMemexId`): the
--     (namespace, memex) slug pair maps to exactly one memex row, joined here rather than
--     matched by LIKE prefix — no `subject_ref LIKE 'ns/mx/%'` anywhere below.
--   * The alternative does not exist. These rows are NULL precisely BECAUSE the summary
--     row that would have resolved them is gone. The ref is the only surviving evidence of
--     which tenant the date belongs to.
--
-- A row whose prefix names no live Memex stays NULL and stays invisible — correct for a
-- deleted tenant, and the honest answer where the evidence has genuinely gone.
--
-- ── COST AND LOCKS [per std-39] ─────────────────────────────────────────────────────────
--
-- ~6,585 rows on a 21,318-row table. The predicate is `memex_id IS NULL`, so a re-run
-- updates nothing and the migration is idempotent by construction. Row locks only, briefly,
-- on a table the emission path upserts one row at a time — no table-level lock is taken and
-- no lock-order hazard exists, unlike 0111/0142 which had to sequence two tables.
--
-- memex_id is indexed (0136), and this UPDATE changes it — so these rows will not be HOT
-- updates. That is 6,585 index tuples, once, against a defect that is currently discarding
-- emissions.

UPDATE ac_first_verified AS f
   SET memex_id = m.id
  FROM namespaces AS n
  JOIN memexes    AS m ON m.namespace_id = n.id
 WHERE f.memex_id IS NULL
   AND split_part(f.subject_ref, '/', 1) = n.slug
   AND split_part(f.subject_ref, '/', 2) = m.slug;

-- Report what could NOT be resolved, so the residue is a stated number rather than a
-- silence. These are refs whose namespace/memex no longer exists; they keep their dates and
-- remain invisible to every tenant, which is what a deleted tenant's row should look like.
DO $$
DECLARE unresolved int;
BEGIN
  SELECT count(*) INTO unresolved FROM ac_first_verified WHERE memex_id IS NULL;
  RAISE NOTICE 'spec-520 issue-12: % ac_first_verified rows remain unresolved (their namespace/memex no longer exists)', unresolved;
END $$;
