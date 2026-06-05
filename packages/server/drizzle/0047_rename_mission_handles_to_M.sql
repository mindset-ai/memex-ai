-- doc-26 t-3: rename Mission handles `doc-N` → `M-N` and sweep all section /
-- comment content to use the new `D-N`, `T-N`, and `M-N` interpolations
-- inline. Eager rename per dec-9 of doc-26 — no aliases, no read-time
-- translation. Standards keep `std-N`; free-form documents and execution-plans
-- keep `doc-N`; only docType='mission' rows are rewritten.
--
-- Order matters:
--   1. Rewrite documents.handle for missions FIRST so all later regexp_replace
--      lookups can derive N from the new `M-N` form.
--   2. Sweep doc_sections.content / doc_comments.content for `dec-N` → `D-N`
--      and `t-N` → `T-N` (these are unconditional; decisions and tasks live
--      under any docType).
--   3. Sweep doc_sections.content / doc_comments.content for `doc-N` → `M-N`
--      ONLY for the N values that correspond to mission rows. The CTE joins
--      to documents (post-rename) and derives the original numeric N from
--      the new handle.
--
-- This migration is idempotent: replays after a partial run leave already-
-- renamed rows untouched (the regex doesn't match `D-N` / `T-N` / `M-N`
-- forms, only the lowercase `dec-N` / `t-N` / `doc-N` forms).

-- ── 1. Rename mission handles. ─────────────────────────────────
UPDATE "documents"
   SET "handle" = 'M-' || substring("handle" from 'doc-(\d+)')
 WHERE "doc_type" = 'mission'
   AND "handle" ~ '^doc-\d+$';

-- ── 2. Rewrite decision / task handle interpolations. ─────────
-- Word boundaries (\m / \M in Postgres) so `dec-12` doesn't get partially
-- matched in something like `mydec-12`. Postgres regex doesn't support \b in
-- the same form as PCRE; we use \m (word start) and \M (word end).
UPDATE "doc_sections"
   SET "content" = regexp_replace("content", '\mdec-(\d+)\M', 'D-\1', 'g')
 WHERE "content" ~ '\mdec-\d+\M';

UPDATE "doc_sections"
   SET "content" = regexp_replace("content", '\mt-(\d+)\M', 'T-\1', 'g')
 WHERE "content" ~ '\mt-\d+\M';

UPDATE "doc_comments"
   SET "content" = regexp_replace("content", '\mdec-(\d+)\M', 'D-\1', 'g')
 WHERE "content" ~ '\mdec-\d+\M';

UPDATE "doc_comments"
   SET "content" = regexp_replace("content", '\mt-(\d+)\M', 'T-\1', 'g')
 WHERE "content" ~ '\mt-\d+\M';

-- ── 3. Rewrite `doc-N` → `M-N` for mission Ns only. ───────────
-- Per-memex CTE so the lookup respects the (memex_id, handle) uniqueness.
-- A `doc-3` reference in a section content body is rewritten to `M-3` only
-- when `M-3` (the renamed Mission) lives in the same memex.
--
-- doc_sections has no memex_id column — its memex is reached via doc_id →
-- documents.memex_id. doc_comments DOES carry memex_id directly so its update
-- can match on the column.
WITH mission_ns AS (
  SELECT memex_id, substring(handle from 'M-(\d+)') AS n
    FROM documents
   WHERE doc_type = 'mission'
     AND handle ~ '^M-\d+$'
)
UPDATE "doc_sections" s
   SET "content" = regexp_replace(s."content", ('\mdoc-' || mn.n || '\M'), ('M-' || mn.n), 'g')
  FROM mission_ns mn, "documents" d
 WHERE s."doc_id" = d."id"
   AND d."memex_id" = mn.memex_id
   AND s."content" ~ ('\mdoc-' || mn.n || '\M');

WITH mission_ns AS (
  SELECT memex_id, substring(handle from 'M-(\d+)') AS n
    FROM documents
   WHERE doc_type = 'mission'
     AND handle ~ '^M-\d+$'
)
UPDATE "doc_comments" c
   SET "content" = regexp_replace(c."content", ('\mdoc-' || mn.n || '\M'), ('M-' || mn.n), 'g')
  FROM mission_ns mn
 WHERE c."memex_id" = mn.memex_id
   AND c."content" ~ ('\mdoc-' || mn.n || '\M');
