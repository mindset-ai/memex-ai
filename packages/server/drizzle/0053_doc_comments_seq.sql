-- b-36 T-2: per-doc seq handles for doc_comments (`c-N`).
--
-- Comments transitively belong to a doc through their section/decision/task
-- target. To mint `c-N` handles in one index lookup (without a 3-way join),
-- we denormalise `doc_id` onto the row and add a `seq` column scoped to
-- (doc_id, seq) — the same shape decisions/tasks already use.
--
-- This migration also renames the existing `doc_sections_doc_id_seq_unique`
-- constraint to `doc_sections_doc_seq_unique` so the two tables share the
-- same naming convention (per the T-2 spec).
--
-- Steps:
--   1. ALTER TABLE doc_sections RENAME CONSTRAINT  → doc_sections_doc_seq_unique
--   2. ALTER TABLE doc_comments ADD COLUMN doc_id  (nullable) + FK
--   3. Backfill doc_id from section/decision/task FK
--   4. ALTER COLUMN doc_id SET NOT NULL
--   5. ALTER TABLE doc_comments ADD COLUMN seq  (nullable)
--   6. Backfill seq via ROW_NUMBER() OVER (PARTITION BY doc_id ORDER BY created_at, id)
--   7. ALTER COLUMN seq SET NOT NULL
--   8. ADD CONSTRAINT doc_comments_doc_seq_unique  UNIQUE (doc_id, seq)

-- ── 1. Rename doc_sections constraint ─────────────────────────────────────
-- The constraint was originally named via 0003_rename_to_docs.sql when
-- strategy_sections → doc_sections. We rename to match the T-2 spec.
ALTER TABLE "doc_sections"
  RENAME CONSTRAINT "doc_sections_doc_id_seq_unique" TO "doc_sections_doc_seq_unique";

-- ── 2. Add doc_id nullable + FK ────────────────────────────────────────────
ALTER TABLE "doc_comments"
  ADD COLUMN "doc_id" uuid REFERENCES "documents" ("id") ON DELETE CASCADE;

-- ── 3. Backfill doc_id from the section/decision/task target ───────────────
-- Section-targeted comments: section_id → docSections.doc_id
UPDATE "doc_comments" c
   SET "doc_id" = s."doc_id"
  FROM "doc_sections" s
 WHERE c."section_id" IS NOT NULL
   AND s."id" = c."section_id";

-- Decision-targeted comments: decision_id → decisions.doc_id
UPDATE "doc_comments" c
   SET "doc_id" = d."doc_id"
  FROM "decisions" d
 WHERE c."decision_id" IS NOT NULL
   AND d."id" = c."decision_id";

-- Task-targeted comments: task_id → tasks.doc_id
UPDATE "doc_comments" c
   SET "doc_id" = t."doc_id"
  FROM "tasks" t
 WHERE c."task_id" IS NOT NULL
   AND t."id" = c."task_id";

-- ── 4. SET NOT NULL on doc_id ──────────────────────────────────────────────
-- The XOR target check guarantees every legacy row had exactly one of
-- section_id / decision_id / task_id, and each of those is itself doc-scoped,
-- so every comment now has a doc_id.
ALTER TABLE "doc_comments"
  ALTER COLUMN "doc_id" SET NOT NULL;

-- ── 5. Add seq nullable ────────────────────────────────────────────────────
ALTER TABLE "doc_comments"
  ADD COLUMN "seq" integer;

-- ── 6. Backfill seq deterministically per doc ──────────────────────────────
-- ORDER BY (created_at, id) so the backfill is stable across re-runs and
-- across replicas (id is the secondary tiebreak — UUIDs are random but
-- deterministic per-row).
UPDATE "doc_comments" c
   SET "seq" = sub.rn
  FROM (
    SELECT "id",
           ROW_NUMBER() OVER (PARTITION BY "doc_id" ORDER BY "created_at", "id") AS rn
      FROM "doc_comments"
  ) sub
 WHERE c."id" = sub."id";

-- ── 7. SET NOT NULL on seq ─────────────────────────────────────────────────
ALTER TABLE "doc_comments"
  ALTER COLUMN "seq" SET NOT NULL;

-- ── 8. Add (doc_id, seq) unique constraint ─────────────────────────────────
ALTER TABLE "doc_comments"
  ADD CONSTRAINT "doc_comments_doc_seq_unique" UNIQUE ("doc_id", "seq");
