-- v2 graph foundation — single coordinated schema migration that unblocks the
-- vertical slices in doc-10 ("Closing the Whitepaper Gap: Evolving Memex to the
-- v2 Graph"). Per dec-1 (big-bang refactor) and dec-7 (one minimal schema pass
-- before vertical work), this is the *only* schema change for the v2 effort.
--
-- Source-of-truth decisions implemented here:
--   dec-1   big-bang refactor (single coordinated migration, not incremental)
--   dec-6   execution_plan_doc_id FK on work_items → documents (plan is a doc)
--   dec-8   structured options on decisions (jsonb) + chosen_option_index
--   dec-11  parent_doc_id self-FK on documents (strategy lineage); intra-doc
--           constraint on dependency edges dropped (handled in service layer)
--   dec-21  decision status enum gains 'candidate' and 'rejected'
--   §7      typed comments — source/comment_type/reference_type/reference_id
--
-- Constraint-name rename: the existing `tasks` table was itself renamed *from*
-- `work_items` long ago (migration 0007), so its PK / FK names are mostly already
-- `work_items_*` from that earlier life. The renames below only touch artifacts
-- that genuinely carry the `tasks_*` prefix today.

-- ── 1. Rename tables: tasks → work_items, task_deps → work_item_deps ──────

ALTER TABLE "tasks" RENAME TO "work_items";
--> statement-breakpoint

ALTER TABLE "task_deps" RENAME TO "work_item_deps";
--> statement-breakpoint

-- Bring the leftover `tasks_*` artefact names in line with the new table name
-- so future Drizzle diffs stay clean.
ALTER TABLE "work_items" RENAME CONSTRAINT "tasks_doc_id_seq_unique" TO "work_items_doc_id_seq_unique";
--> statement-breakpoint
ALTER TABLE "work_items" RENAME CONSTRAINT "tasks_account_id_accounts_id_fk" TO "work_items_account_id_accounts_id_fk";
--> statement-breakpoint
ALTER INDEX "tasks_account_id_idx" RENAME TO "work_items_account_id_idx";
--> statement-breakpoint

-- ── 2. Rename task_id columns → work_item_id ───────────────────────────────

ALTER TABLE "decision_deps" RENAME COLUMN "task_id" TO "work_item_id";
--> statement-breakpoint

ALTER TABLE "work_item_deps" RENAME COLUMN "task_id" TO "work_item_id";
--> statement-breakpoint

ALTER TABLE "doc_comments" RENAME COLUMN "task_id" TO "work_item_id";
--> statement-breakpoint

-- doc_comments is the one table where the FK constraint name explicitly named
-- the old `tasks` table — bring that into line with the rename.
ALTER TABLE "doc_comments" RENAME CONSTRAINT "doc_comments_task_id_tasks_id_fk" TO "doc_comments_work_item_id_work_items_id_fk";
--> statement-breakpoint

-- ── 3. Strategy lineage + execution-plan FKs ──────────────────────────────

ALTER TABLE "documents"
  ADD COLUMN "parent_doc_id" uuid REFERENCES "documents"("id") ON DELETE SET NULL;
--> statement-breakpoint

ALTER TABLE "work_items"
  ADD COLUMN "execution_plan_doc_id" uuid REFERENCES "documents"("id") ON DELETE SET NULL;
--> statement-breakpoint

-- ── 4. Structured decision options (dec-8) ────────────────────────────────

ALTER TABLE "decisions"
  ADD COLUMN "options" jsonb;
--> statement-breakpoint

ALTER TABLE "decisions"
  ADD COLUMN "chosen_option_index" integer;
--> statement-breakpoint

-- ── 5. Decision status enum: add 'candidate' and 'rejected' (dec-21) ──────

ALTER TABLE "decisions"
  ADD CONSTRAINT "decisions_status_valid"
  CHECK ("status" IN ('open', 'resolved', 'candidate', 'rejected'));
--> statement-breakpoint

-- ── 6. Typed comments (Section 7 of doc-10) ───────────────────────────────
-- Backfill: NOT NULL + DEFAULT means existing rows transparently become
-- (comment_type='discussion', source='human'), which is the correct
-- interpretation of pre-v2 freeform comments.

ALTER TABLE "doc_comments"
  ADD COLUMN "comment_type" text NOT NULL DEFAULT 'discussion';
--> statement-breakpoint

ALTER TABLE "doc_comments"
  ADD COLUMN "source" text NOT NULL DEFAULT 'human';
--> statement-breakpoint

ALTER TABLE "doc_comments"
  ADD COLUMN "reference_type" text;
--> statement-breakpoint

ALTER TABLE "doc_comments"
  ADD COLUMN "reference_id" text;
--> statement-breakpoint

ALTER TABLE "doc_comments"
  ADD CONSTRAINT "doc_comments_comment_type_valid"
  CHECK ("comment_type" IN (
    'discussion', 'plan', 'progress', 'issue', 'deferred', 'cross_reference',
    'question', 'review', 'readiness_check', 'approval', 'plan_revision', 'drift'
  ));
--> statement-breakpoint

ALTER TABLE "doc_comments"
  ADD CONSTRAINT "doc_comments_source_valid"
  CHECK ("source" IN ('human', 'agent'));
--> statement-breakpoint

ALTER TABLE "doc_comments"
  ADD CONSTRAINT "doc_comments_reference_type_valid"
  CHECK ("reference_type" IS NULL OR "reference_type" IN ('work_item', 'strategy', 'decision', 'blueprint'));
--> statement-breakpoint

-- The existing 'doc_comments_exactly_one_target' XOR check still references the
-- old `task_id` column. Drop and recreate against work_item_id.
ALTER TABLE "doc_comments" DROP CONSTRAINT IF EXISTS "doc_comments_exactly_one_target";
--> statement-breakpoint

ALTER TABLE "doc_comments"
  ADD CONSTRAINT "doc_comments_exactly_one_target"
  CHECK (
    (CASE WHEN "section_id" IS NOT NULL THEN 1 ELSE 0 END
     + CASE WHEN "decision_id" IS NOT NULL THEN 1 ELSE 0 END
     + CASE WHEN "work_item_id" IS NOT NULL THEN 1 ELSE 0 END) = 1
  );
