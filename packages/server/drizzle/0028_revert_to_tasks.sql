-- 0028_revert_to_tasks
--
-- Per doc-5 Issue 2 (and dec-4 scope correction): revert the partial
-- `tasks` → `work_items` rename that landed in 0026_v2_graph_foundation.
-- The product noun is "tasks" everywhere — DB, server, MCP, React UI,
-- agent prompting. "Work items" is dropped as a concept.
--
-- This migration is the symmetric inverse of section 1+2 of 0026: explicit
-- ALTER TABLE RENAMEs, no drop+recreate, all rows preserved. Safe to apply
-- to int (which has real data) and locally.
--
-- It does NOT touch the new columns 0026 added (parent_doc_id,
-- execution_plan_doc_id, structured decision options, typed comments) —
-- those stay. Only the work_items ↔ tasks naming gets reverted, plus the
-- one reference_type CHECK that listed 'work_item' and the XOR target
-- constraint on doc_comments.

-- ── 1. Rename tables: work_items → tasks, work_item_deps → task_deps ─────

ALTER TABLE "work_items" RENAME TO "tasks";
--> statement-breakpoint

ALTER TABLE "work_item_deps" RENAME TO "task_deps";
--> statement-breakpoint

-- Bring constraint + index names in line with the new table name. Use DO
-- blocks so we tolerate missing legacy constraints (some local DBs were
-- rebuilt from a fresh drizzle pass and never carried the work_items_*
-- artefact names that 0026 set up).
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'work_items_doc_id_seq_unique'
  ) THEN
    EXECUTE 'ALTER TABLE "tasks" RENAME CONSTRAINT "work_items_doc_id_seq_unique" TO "tasks_doc_id_seq_unique"';
  END IF;
END$$;
--> statement-breakpoint

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'work_items_account_id_accounts_id_fk'
  ) THEN
    EXECUTE 'ALTER TABLE "tasks" RENAME CONSTRAINT "work_items_account_id_accounts_id_fk" TO "tasks_account_id_accounts_id_fk"';
  END IF;
END$$;
--> statement-breakpoint

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_class
    WHERE relname = 'work_items_account_id_idx' AND relkind = 'i'
  ) THEN
    EXECUTE 'ALTER INDEX "work_items_account_id_idx" RENAME TO "tasks_account_id_idx"';
  END IF;
END$$;
--> statement-breakpoint

-- ── 2. Rename work_item_id columns → task_id ─────────────────────────────

ALTER TABLE "decision_deps" RENAME COLUMN "work_item_id" TO "task_id";
--> statement-breakpoint

ALTER TABLE "task_deps" RENAME COLUMN "work_item_id" TO "task_id";
--> statement-breakpoint

ALTER TABLE "doc_comments" RENAME COLUMN "work_item_id" TO "task_id";
--> statement-breakpoint

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'doc_comments_work_item_id_work_items_id_fk'
  ) THEN
    EXECUTE 'ALTER TABLE "doc_comments" RENAME CONSTRAINT "doc_comments_work_item_id_work_items_id_fk" TO "doc_comments_task_id_tasks_id_fk"';
  END IF;
END$$;
--> statement-breakpoint

-- ── 3. Recreate the XOR target constraint against task_id ────────────────
-- The CHECK in 0026 references work_item_id by name; drop and recreate
-- against the new column.

ALTER TABLE "doc_comments" DROP CONSTRAINT IF EXISTS "doc_comments_exactly_one_target";
--> statement-breakpoint

ALTER TABLE "doc_comments"
  ADD CONSTRAINT "doc_comments_exactly_one_target"
  CHECK (
    (CASE WHEN "section_id" IS NOT NULL THEN 1 ELSE 0 END
     + CASE WHEN "decision_id" IS NOT NULL THEN 1 ELSE 0 END
     + CASE WHEN "task_id" IS NOT NULL THEN 1 ELSE 0 END) = 1
  );
--> statement-breakpoint

-- ── 4. reference_type enum: 'work_item' → 'task' ─────────────────────────
-- 0026 added a CHECK that allows 'work_item' as a reference_type value.
-- Backfill existing rows first, then replace the constraint.

UPDATE "doc_comments" SET "reference_type" = 'task' WHERE "reference_type" = 'work_item';
--> statement-breakpoint

ALTER TABLE "doc_comments" DROP CONSTRAINT IF EXISTS "doc_comments_reference_type_valid";
--> statement-breakpoint

ALTER TABLE "doc_comments"
  ADD CONSTRAINT "doc_comments_reference_type_valid"
  CHECK ("reference_type" IS NULL OR "reference_type" IN ('task', 'strategy', 'decision', 'blueprint'));
--> statement-breakpoint
