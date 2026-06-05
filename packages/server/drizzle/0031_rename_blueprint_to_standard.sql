-- Rename docType 'blueprint' → 'standard' (t-1 of doc-8).
--
-- Background: the user-facing noun "Blueprint" is being renamed to "Standard" as a
-- coordinated product rename, and the internal docType enum value follows. Per
-- dec-1 of doc-8 this is a single hard-cut PR — no alias period, no dual code
-- paths. Per dec-7 standards also adopt a `std-N` typed handle prefix; the
-- handle-generation logic moves into a dedicated `nextStandardHandle`. No
-- existing blueprints in production means no `doc-N` → `std-N` handle backfill
-- is needed; this migration is purely the docType + reference_type rename.
--
-- Two changes in one file because they are one logical operation:
--
--   1. UPDATE documents.doc_type rows: 'blueprint' → 'standard'.
--   2. Drop + UPDATE + recreate the doc_comments_reference_type_valid CHECK
--      constraint so cross-reference comments can target the new docType name.
--
-- Mirrors the 0028/0029 pair that handled 'strategy' → 'mission'. doc_type
-- itself is free-text with no Postgres enum and no CHECK, so step 1 is a pure
-- data update — no type alter or enum drop. The reference_type CHECK does
-- enumerate the allowed cross-reference targets, so step 2 is the standard
-- drop-update-readd dance.
--
-- Post-merge note: this file moved from 0030 → 0031 when main's
-- 0030_rename_strategy_repos_to_mission_repos.sql claimed the 0030 slot
-- during the doc-8 → main merge. The constraint allowlist now reads
-- ('task', 'mission', 'decision', 'standard') because 0028_revert_to_tasks
-- (also from main) renamed 'work_item' refs back to 'task'.

-- 1. docType data rename ─────────────────────────────────────
UPDATE "documents" SET "doc_type" = 'standard' WHERE "doc_type" = 'blueprint';

-- 2. doc_comments.reference_type CHECK rebuild ───────────────
ALTER TABLE "doc_comments" DROP CONSTRAINT IF EXISTS "doc_comments_reference_type_valid";

UPDATE "doc_comments" SET "reference_type" = 'standard' WHERE "reference_type" = 'blueprint';

ALTER TABLE "doc_comments" ADD CONSTRAINT "doc_comments_reference_type_valid"
  CHECK ("reference_type" IS NULL OR "reference_type" IN ('task', 'mission', 'decision', 'standard'));
