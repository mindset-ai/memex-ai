-- Rename work_items → tasks
ALTER TABLE "work_items" RENAME TO "tasks";
ALTER TABLE "tasks" RENAME CONSTRAINT "work_items_doc_id_seq_unique" TO "tasks_doc_id_seq_unique";

-- Rename work_item_deps → task_deps
ALTER TABLE "work_item_deps" RENAME TO "task_deps";
ALTER TABLE "task_deps" RENAME COLUMN "work_item_id" TO "task_id";

-- Rename work_item_id in decision_deps
ALTER TABLE "decision_deps" RENAME COLUMN "work_item_id" TO "task_id";
