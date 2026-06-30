-- spec-151 dec-5 (t-5) — persisted clause TESTABILITY classification columns.
--
-- WHY: a Standard's clause-coverage view needs to know, per clause, whether it is an
--   obligation that CAN carry a universal test, and (when testable) which archetype of
--   test proves it. That verdict is ONE value per clause, so it lives as columns on
--   standard_clauses (std-32's load-bearing-→-column rule), not a join table like
--   standard_clause_facets (facets are many-per-clause; testability is one-per-clause).
--
-- WHAT: three nullable columns. NULL = not-yet-classified (the gap the operator backfill
--   fills). Readers: the clause-coverage denominator reads is_obligation + testable
--   (only is_obligation && testable clauses count); the test-writing/verifying agents
--   read archetype. `confidence` is deliberately NOT persisted (spike-only triage signal,
--   no production reader — dec-5).
--
-- COST/LOCKS (std-39): all three are nullable ADD COLUMN with no default, so each is a
--   catalog-only change — no table rewrite, no long lock. Additive and backward-compatible.
--
-- Idempotent (IF NOT EXISTS): the hand-migration runner may re-apply on a partially
--   migrated DB; re-running is a no-op.

ALTER TABLE standard_clauses ADD COLUMN IF NOT EXISTS is_obligation boolean;
ALTER TABLE standard_clauses ADD COLUMN IF NOT EXISTS testable boolean;
ALTER TABLE standard_clauses ADD COLUMN IF NOT EXISTS archetype text;
