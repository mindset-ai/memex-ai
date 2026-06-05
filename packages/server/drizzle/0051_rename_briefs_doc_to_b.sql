-- doc-30 t-2 / dec-1 / dec-3: rename Brief handles `doc-N` → `b-N` and sweep
-- all section / comment content to use the new `b-N` interpolation inline.
-- Lowercase per dec-3 (matches the URL-surface convention of `std-N`/`doc-N`).
-- Eager rename — no aliases, no read-time translation. Standards keep `std-N`;
-- free-form documents and execution-plans keep `doc-N`; only Brief rows
-- (doc_type IN ('brief', 'mission')) are rewritten. Decision (`D-N`) and
-- task (`T-N`) handles are unchanged — they were renamed in 0047.
--
-- Background:
--   * 0047 renamed mission `doc-N` handles to `M-N`.
--   * 0048 reverted briefs/missions back to `doc-N` (course-correction).
--   * 0049 then rewrote doc_type='mission' rows to doc_type='brief'.
--   * This migration completes the original intent: briefs adopt `b-N`.
--
-- Replay-safe: matches `^doc-\d+$` AND `^B-\d+$` (the latter accounts for any
-- environment that may have applied an in-flight uppercase intermediate before
-- dec-3 settled on lowercase).
--
-- Order matters:
--   1. Rewrite documents.handle for briefs FIRST so step 2's CTE can derive
--      the original numeric N from the new `b-N` form.
--   2. Sweep doc_sections.content / doc_comments.content for `doc-N` / `B-N`
--      references ONLY for the N values that correspond to brief rows. The CTE
--      joins to documents (post-rename) so each Memex's brief Ns are resolved
--      independently.
--
-- Match doc_type IN ('brief', 'mission') for defence in depth — 0049 should
-- have converted all 'mission' rows to 'brief', but if this migration runs
-- against a database where 0049 hasn't applied yet (or migrations replay from
-- an earlier snapshot), we catch both.
--
-- Idempotent: once briefs are at `b-N`, none of the source patterns match.

-- ── 1. Rename brief handles `doc-N` or `B-N` → `b-N`. ────────────────────
UPDATE "documents"
   SET "handle" = 'b-' || coalesce(
                           substring("handle" from '^doc-(\d+)$'),
                           substring("handle" from '^B-(\d+)$')
                         )
 WHERE "doc_type" IN ('brief', 'mission')
   AND ("handle" ~ '^doc-\d+$' OR "handle" ~ '^B-\d+$');

-- ── 2. Sweep doc_sections.content for brief Ns only. ─────────────────────
-- doc_sections has no memex_id column — reach memex_id via doc_id → documents.memex_id.
-- Replaces both `doc-N` (pre-doc-30) and `B-N` (intermediate uppercase state) with `b-N`.
WITH brief_ns AS (
  SELECT memex_id, substring(handle from '^b-(\d+)$') AS n
    FROM documents
   WHERE doc_type IN ('brief', 'mission')
     AND handle ~ '^b-\d+$'
)
UPDATE "doc_sections" s
   SET "content" = regexp_replace(
                     regexp_replace(s."content", ('\mdoc-' || bn.n || '\M'), ('b-' || bn.n), 'g'),
                     ('\mB-' || bn.n || '\M'), ('b-' || bn.n), 'g'
                   )
  FROM brief_ns bn, "documents" d
 WHERE s."doc_id" = d."id"
   AND d."memex_id" = bn.memex_id
   AND (s."content" ~ ('\mdoc-' || bn.n || '\M') OR s."content" ~ ('\mB-' || bn.n || '\M'));

-- ── 3. Sweep doc_comments.content for brief Ns only. ─────────────────────
-- doc_comments carries memex_id directly, so its update can match on the column.
WITH brief_ns AS (
  SELECT memex_id, substring(handle from '^b-(\d+)$') AS n
    FROM documents
   WHERE doc_type IN ('brief', 'mission')
     AND handle ~ '^b-\d+$'
)
UPDATE "doc_comments" c
   SET "content" = regexp_replace(
                     regexp_replace(c."content", ('\mdoc-' || bn.n || '\M'), ('b-' || bn.n), 'g'),
                     ('\mB-' || bn.n || '\M'), ('b-' || bn.n), 'g'
                   )
  FROM brief_ns bn
 WHERE c."memex_id" = bn.memex_id
   AND (c."content" ~ ('\mdoc-' || bn.n || '\M') OR c."content" ~ ('\mB-' || bn.n || '\M'));
