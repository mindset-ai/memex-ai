-- spec-522 t-1 (ac-7, ac-8, ac-9, ac-5) — materialise the FTS tsvector on
-- `decisions` and `issues` so the ⌘K search arms stop sequentially scanning.
--
-- THE MEASUREMENT THAT MOTIVATES THIS (spec-522 s-2, taken against live prod on
-- 2026-08-06, method and raw samples recorded in the Spec):
--
--   | variant                       | embeds | p50    |
--   |-------------------------------|--------|--------|
--   | handle short-circuit (floor)  | 0      | 214 ms |
--   | ?kind=issue                   | 1      | 354 ms |
--   | ?kind=standard                | 1      | 377 ms |
--   | ?kind=spec                    | 1      | 439 ms |
--   | ?kind=decision                | 1      | 784 ms |  <-- the outlier
--   | no kind (what ⌘K sends)       | 3      | 810 ms |
--
--   Three single-embed arms hitting completely different tables and index sizes
--   land within 85 ms of each other; `kind=decision` is ~2x all of them and sits
--   within 26 ms of the full six-arm search. Since the arms run concurrently
--   under one Promise.all, total ≈ max(arms) — so the decisions arm alone was
--   very nearly the entire cost of ⌘K.
--
--   Proof it is a SCAN and not result assembly: a nonsense query matching ZERO
--   rows still cost 746 ms on kind=decision versus 356 ms on the structurally
--   identical kind=issue. ~390 ms spent to discover nothing matched.
--
-- WHY IT WAS SLOW. `runDecisionFts` / `runIssueFts`
-- (services/memex-search/retrieval.ts) had no index to use, so they built
--   to_tsvector('english', coalesce(title,'') || ' ' || coalesce(context,'') || ' ' || coalesce(resolution,''))
-- PER ROW, TWICE — once in the WHERE predicate and again inside ts_rank in the
-- SELECT — across every decision in the Memex, on every settled keystroke burst.
-- Decision `context` and `resolution` are long prose, so each row was expensive
-- to tokenise.
--
-- spec-34 dec-2 added `embedding` / `embedding_model` / `embedding_updated_at` to
-- `decisions` "mirroring the doc_sections pattern". It mirrored the VECTOR half
-- and never the tsvector half. That is where this gap was born; the same omission
-- was then copied to `issues` by spec-112.
--
-- BOTH TABLES, ONE MIGRATION (spec-522 dec-4). `issues` runs the identical
-- unindexed pattern and is cheap today only because the table is still small —
-- s-2 uses it as the experimental control precisely for that reason. std-39
-- requires reasoning about GROWTH, not present cost, so `issues` is fixed here
-- rather than waited for. It is the next `decisions`.
--
-- PARITY IS THE SHARP EDGE (ac-9, ac-3). The generated expression below
-- reproduces the previous inline one exactly — same field order, same
-- coalesce(x,'') handling, same ' ' separators, same 'english' config — so
-- ts_rank returns identical scores and results do not reorder. The only textual
-- difference is the explicit ::regconfig cast, which is REQUIRED and not
-- cosmetic: to_tsvector(text, text) is merely STABLE and Postgres rejects it in a
-- generated column, while the two-argument regconfig form is IMMUTABLE. The two
-- produce the same tsvector for the same input. Same cast used by 0027
-- (doc_sections), 0023 (files) and 0079 (guide_content).
--
-- std-39 — the cost reasoning, recorded at design time rather than discovered in
-- production:
--   * LOCKS / REWRITE. This is the real cost of this migration and it is NOT the
--     index. `ADD COLUMN ... GENERATED ALWAYS AS (...) STORED` is a STORED
--     generated column, so unlike a plain nullable ADD COLUMN it cannot be a
--     catalogue-only change: Postgres rewrites the whole table and holds ACCESS
--     EXCLUSIVE for the duration, blocking reads as well as writes. Acceptable
--     here because both tables are small — `decisions` is bounded by
--     (Specs × decisions per Spec) and `issues` by the open bug/todo backlog,
--     both in the low thousands for the largest Memex, which is a rewrite
--     measured in well under a second. It is NOT acceptable at a different order
--     of magnitude: if `decisions` ever reaches the millions, this migration
--     shape must be replaced by add-nullable-column + backfill-in-batches +
--     trigger, which is the standard no-rewrite alternative. Measure before
--     assuming (spec-522 s-2 records that no prod row count was available when
--     this was authored).
--   * NO BACKFILL UPDATE. A GENERATED column is populated by the rewrite itself,
--     so there is no separate backfill statement to order against the live write
--     path — no lock_timeout / lock-ordering hazard (cl-2, cl-3) applies.
--   * GROWTH (cl-4, cl-23). These are per-ROW columns on existing tables, not a
--     new per-event table, so they add no row accrual and owe no retention or
--     aging policy. They do add stored bytes: a tsvector holds deduplicated
--     lexemes plus positions and typically lands well under the size of its
--     source text, but `decisions.context` + `resolution` are the longest prose
--     in the schema, so this is the largest such column in the database. That is
--     the price of not tokenising the same text on every keystroke.
--   * INDEX BUILD (cl-20). The indexes below use a PLAIN inline CREATE INDEX, not
--     CONCURRENTLY. This is a deliberate call, not an oversight, and it is a
--     conscious deviation from spec-522 dec-4, which specified CONCURRENTLY
--     before the constraint below was known:
--       CONCURRENTLY cannot run inside a transaction, and this repo's
--       hand-migration runner wraps every file in one
--       (scripts/apply-hand-migrations.mjs:78-92 — `sql.begin(...)`). So
--       CONCURRENTLY would have to be an out-of-band step. Precedent for the
--       plain form on the same reasoning: 0111, 0125 and 0131.
--     It is not warranted at this size anyway: a GIN build over a few thousand
--     rows is milliseconds, not the "large, already-populated table" cl-20 is
--     written for — and the table is being rewritten by the ADD COLUMN above
--     regardless, which already takes the stronger lock. If these tables ever
--     grow to where that stops being true, both the column add and the index
--     belong out-of-band.
--   * INDEX JUSTIFICATION (cl-18, cl-19, cl-25). The indexes serve the FTS
--     predicate on the single hottest read path in the product — every settled
--     ⌘K keystroke, every MCP `search_memex` call, and the agent's duplicate-issue
--     detection. Measured cost of not having them: ~390 ms per search, paid even
--     when nothing matches. The write cost is negligible and lands on the right
--     side of the trade: decisions and issues are written once or twice in their
--     lifetime and read on every search, which is the textbook case where an
--     index is clearly worth its maintenance.
--
-- std-36 — new columns on RLS-enabled tables. `decisions` and `issues` both carry
-- their memex_id isolation policy already (src/db/rls-tables.ts), and a policy
-- covers every COLUMN of its table, so NO new or altered policy is needed and none
-- is added. The generated value is derived entirely from columns in the same row,
-- so it can expose nothing the row's existing policy did not already permit.
--
-- NOT MODELLED IN DRIZZLE, deliberately. `content_tsv` stays out of schema.ts,
-- matching doc_sections (schema.ts:299-315 records the reason: a Drizzle column
-- becomes required on InferSelectModel and forces every test fixture to set it)
-- and matching the embedding triplet already kept out of `decisions` / `issues`
-- for the same reason. Queries reach it through raw sql`` in retrieval.ts.
--
-- REVERSIBLE by DROP INDEX + DROP COLUMN on both tables; see the paired revert.
-- Reverting restores the inline to_tsvector arms, i.e. the sequential scan.
--
-- Idempotent (IF NOT EXISTS): the hand-migration runner wraps each file in a
-- transaction, and CI (.github/workflows/test.yml) replays every drizzle/*.sql
-- with `psql -f` in filename order, so this file must be safe to re-apply.

ALTER TABLE "decisions"
  ADD COLUMN IF NOT EXISTS "content_tsv" tsvector
  GENERATED ALWAYS AS (
    to_tsvector(
      'english'::regconfig,
      COALESCE("title", ''::text) || ' ' ||
      COALESCE("context", ''::text) || ' ' ||
      COALESCE("resolution", ''::text)
    )
  ) STORED;

CREATE INDEX IF NOT EXISTS "decisions_content_tsv_idx"
  ON "decisions" USING gin ("content_tsv");

ALTER TABLE "issues"
  ADD COLUMN IF NOT EXISTS "content_tsv" tsvector
  GENERATED ALWAYS AS (
    to_tsvector(
      'english'::regconfig,
      COALESCE("title", ''::text) || ' ' ||
      COALESCE("body", ''::text)
    )
  ) STORED;

CREATE INDEX IF NOT EXISTS "issues_content_tsv_idx"
  ON "issues" USING gin ("content_tsv");
