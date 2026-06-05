-- doc-26 t-12 (Mission → Brief, part 3): rename column
-- doc_comments.reference_mission_id → reference_brief_id and rebuild the
-- doc_comments_cross_reference_target CHECK constraint so it references the
-- new column name. Pure structural rename — no row-data rewrite, the
-- column's value (a documents.id UUID) is unchanged.
--
-- Authored manually rather than via `drizzle-kit generate` because (a) the
-- generator's snapshot state in `drizzle/meta/` is years out of sync with
-- the hand-written migrations and (b) Drizzle would emit a DROP COLUMN +
-- ADD COLUMN for a rename, losing every backfilled FK from migration 0045.
-- A direct ALTER TABLE RENAME COLUMN keeps both the column data and the FK
-- definition (PostgreSQL preserves FOREIGN KEY constraints across renames).
--
-- The CHECK constraint must be dropped and re-added because its expression
-- text bakes in the literal column name (Postgres stores the parsed
-- expression, but the easiest portable way to update it is drop + add).

-- ── 1. Rename column. ────────────────────────────────────────
ALTER TABLE "doc_comments"
  RENAME COLUMN "reference_mission_id" TO "reference_brief_id";

-- ── 2. Rebuild CHECK constraint. ─────────────────────────────
ALTER TABLE "doc_comments"
  DROP CONSTRAINT "doc_comments_cross_reference_target";

ALTER TABLE "doc_comments"
  ADD CONSTRAINT "doc_comments_cross_reference_target"
  CHECK (
    "comment_type" <> 'cross_reference'
    OR (
      (CASE WHEN "reference_brief_id"    IS NOT NULL THEN 1 ELSE 0 END
     + CASE WHEN "reference_standard_id" IS NOT NULL THEN 1 ELSE 0 END
     + CASE WHEN "reference_decision_id" IS NOT NULL THEN 1 ELSE 0 END
     + CASE WHEN "reference_task_id"     IS NOT NULL THEN 1 ELSE 0 END
      ) <= 1
    )
  );
