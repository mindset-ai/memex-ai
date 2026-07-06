-- spec-418 t-1 (dec-8): case-insensitive tag uniqueness + one-time case-fold.
--
-- spec-136 shipped `tags` with a CASE-SENSITIVE unique (memex_id, scope, value)
-- NULLS NOT DISTINCT (migration 0070). Free-create let case-variant pairs accrete
-- (`API` vs `api`, `Deploy::x` vs `deploy::x`) that look identical in the UI but are
-- distinct rows. dec-8 forces case-insensitive uniqueness — a `lower(scope),
-- lower(value)` expression unique index — while preserving the FIRST writer's display
-- casing. That index cannot be created while legacy case-variants exist, so this
-- migration FOLDS them first, THEN swaps the constraint for the CI index.
--
-- ── Execution posture [per std-36] ──────────────────────────────────────────────
-- This file runs as the OWNER role (the deploy / dev hand-runner connects as the
-- database owner; the runtime `memex_app` role never applies migrations). The owner
-- BYPASSES row-level security, which is REQUIRED here: the fold is a cross-tenant
-- set-based sweep over every Memex at once, and the RLS-subject runtime role can only
-- ever see one tenant (runWithMemexId). There is deliberately NO `SET ROLE` and NO
-- `FORCE` toggle in this file — RLS on tags/document_tags stays ENABLE (NO FORCE) as
-- migrations 0081/0086/0093 left it; the owner's inherent bypass is the whole point.
--
-- ── Locks & cost [per std-39] ───────────────────────────────────────────────────
-- The fold is TWO bounded set-based statements (one INSERT..SELECT to re-point links
-- onto survivors, one DELETE to drop the losing catalogue rows) — O(rows), not O(N)
-- round-trips, regardless of how many Specs a tag is on. The hand-runner wraps the
-- whole file in ONE transaction, so the fold + constraint swap + index build either
-- all apply or all roll back; a half-applied state (folded but no CI index, or an
-- index that rejects surviving legacy dupes) is impossible. The main lock cost is the
-- final CREATE UNIQUE INDEX, which takes a short ACCESS EXCLUSIVE / SHARE lock on
-- `tags` — acceptable: `tags` is a small per-Memex catalogue table (tens–hundreds of
-- rows per tenant), so a plain (non-CONCURRENT) build inside the transaction is cheap
-- and keeps the migration atomic. If `tags` ever grows large enough to warrant it, a
-- CREATE INDEX CONCURRENTLY would have to move OUT of this transaction — not needed at
-- current scale.

-- ── 1. Re-point document_tags from losing variants onto the survivor ─────────────
-- Survivor per case-insensitive group (memex_id, lower(scope), lower(value)) = the
-- MOST-USED variant (highest document_tags count), earliest created_at as the
-- deterministic tie-break, id as a final total-order tie-break. NULL scope groups via
-- lower(scope) IS NULL (window PARTITION BY treats NULLs as one group), so flat tags
-- fold too. We INSERT a survivor link for every (doc, survivor) a losing link implies,
-- DISTINCT ON (doc, survivor) so at most one candidate row is proposed per pair, and
-- ON CONFLICT DO NOTHING dedupes against links the Spec ALREADY carries for the
-- survivor — leaving no duplicate (the document_tags_document_tag_unique invariant
-- holds). The losing links themselves are removed in step 2 via the FK cascade.
WITH usage AS (
  SELECT t.id AS tag_id, t.memex_id, t.scope, t.value, t.created_at,
         count(dt.id) AS link_count
  FROM tags t
  LEFT JOIN document_tags dt ON dt.tag_id = t.id
  GROUP BY t.id
),
fold_map AS (
  SELECT tag_id AS loser_id,
         first_value(tag_id) OVER (
           PARTITION BY memex_id, lower(scope), lower(value)
           ORDER BY link_count DESC, created_at ASC, tag_id ASC
         ) AS survivor_id
  FROM usage
)
INSERT INTO document_tags (memex_id, document_id, tag_id, added_by, created_at)
SELECT DISTINCT ON (dt.document_id, fm.survivor_id)
       dt.memex_id, dt.document_id, fm.survivor_id, dt.added_by, dt.created_at
FROM document_tags dt
JOIN fold_map fm ON dt.tag_id = fm.loser_id AND fm.loser_id <> fm.survivor_id
ORDER BY dt.document_id, fm.survivor_id, dt.created_at ASC, dt.id ASC
ON CONFLICT (document_id, tag_id) DO NOTHING;
--> statement-breakpoint

-- ── 2. Delete the losing catalogue rows (FK cascade drops their links) ────────────
-- document_tags.tag_id → tags(id) ON DELETE CASCADE (migration 0070), so deleting a
-- loser tag removes its now-superseded links in one step — no explicit link-sweep, no
-- orphans. The mapping is recomputed identically; it is STABLE across step 1 because a
-- survivor was already the max-count variant and step 1 only ADDS links to it, so it
-- remains the argmax (losers' counts are untouched until this delete).
WITH usage AS (
  SELECT t.id AS tag_id, t.memex_id, t.scope, t.value, t.created_at,
         count(dt.id) AS link_count
  FROM tags t
  LEFT JOIN document_tags dt ON dt.tag_id = t.id
  GROUP BY t.id
),
fold_map AS (
  SELECT tag_id AS loser_id,
         first_value(tag_id) OVER (
           PARTITION BY memex_id, lower(scope), lower(value)
           ORDER BY link_count DESC, created_at ASC, tag_id ASC
         ) AS survivor_id
  FROM usage
)
DELETE FROM tags t
USING fold_map fm
WHERE t.id = fm.loser_id AND fm.loser_id <> fm.survivor_id;
--> statement-breakpoint

-- ── 3. Drop the case-SENSITIVE unique constraint (0070) ──────────────────────────
ALTER TABLE tags DROP CONSTRAINT tags_memex_scope_value_unique;
--> statement-breakpoint

-- ── 4. Create the case-INSENSITIVE expression unique index ───────────────────────
-- lower(scope), lower(value) collapses case-variants to one row. NULLS NOT DISTINCT
-- (pg16 supports it on an index) preserves 0070's canonicalisation of flat tags:
-- without it two flat `bug` rows (scope = NULL → lower(scope) = NULL) would both be
-- allowed, since NULL <> NULL in a default unique. Built AFTER the fold so it can't
-- fail on legacy dupes.
CREATE UNIQUE INDEX tags_memex_scope_value_ci_unique
  ON tags (memex_id, lower(scope), lower(value)) NULLS NOT DISTINCT;
