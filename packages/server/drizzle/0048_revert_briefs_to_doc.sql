-- doc-26 t-12: revert mission/brief handles back to generic `doc-N`.
-- Migration 0047 took mission `doc-N` handles to `M-N`. Per current
-- convention, briefs use the generic `doc-N` like all other docs in the
-- `documents` table. This migration undoes 0047's handle rewrite (and
-- handles any intermediate `B-N` state from earlier iterations of this
-- migration so re-runs from any prior state converge to `doc-N`).
--
-- Decisions and tasks (`D-N` / `T-N`) are unchanged — only the brief
-- handle namespace returns to `doc-N`.
--
-- Order matters:
--   1. Revert documents.handle for briefs/missions FIRST.
--   2. Sweep doc_sections.content for `M-N` / `B-N` references in those
--      same N values back to `doc-N`. doc_sections has no memex_id
--      column — reach memex_id via doc_id → documents.memex_id.
--   3. Sweep doc_comments.content for `M-N` / `B-N` → `doc-N`.
--
-- Idempotent: matches `M-N` and `B-N` only; once handles are `doc-N`,
-- the regex finds nothing and replay is a no-op.

-- ── 1. Revert brief handles M-N (or B-N from earlier iteration) → doc-N. ──
UPDATE "documents"
   SET "handle" = 'doc-' || substring("handle" from '^[MB]-(\d+)$')
 WHERE "handle" ~ '^[MB]-\d+$';

-- ── 2. Sweep doc_sections.content. ───────────────────────────────────────
WITH brief_ns AS (
  SELECT d.memex_id, substring(d.handle from '^doc-(\d+)$') AS n, d.id AS doc_id
    FROM documents d
   WHERE d.handle ~ '^doc-\d+$'
     AND d.doc_type IN ('mission', 'brief')
)
UPDATE "doc_sections" s
   SET "content" = regexp_replace(
                     regexp_replace(s."content", ('\mM-' || bn.n || '\M'), ('doc-' || bn.n), 'g'),
                     ('\mB-' || bn.n || '\M'), ('doc-' || bn.n), 'g'
                   )
  FROM brief_ns bn, "documents" d
 WHERE s."doc_id" = d."id"
   AND d."memex_id" = bn.memex_id
   AND (s."content" ~ ('\mM-' || bn.n || '\M') OR s."content" ~ ('\mB-' || bn.n || '\M'));

-- ── 3. Sweep doc_comments.content. ───────────────────────────────────────
WITH brief_ns AS (
  SELECT d.memex_id, substring(d.handle from '^doc-(\d+)$') AS n
    FROM documents d
   WHERE d.handle ~ '^doc-\d+$'
     AND d.doc_type IN ('mission', 'brief')
)
UPDATE "doc_comments" c
   SET "content" = regexp_replace(
                     regexp_replace(c."content", ('\mM-' || bn.n || '\M'), ('doc-' || bn.n), 'g'),
                     ('\mB-' || bn.n || '\M'), ('doc-' || bn.n), 'g'
                   )
  FROM brief_ns bn
 WHERE c."memex_id" = bn.memex_id
   AND (c."content" ~ ('\mM-' || bn.n || '\M') OR c."content" ~ ('\mB-' || bn.n || '\M'));
