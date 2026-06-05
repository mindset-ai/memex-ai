-- Add archive support to documents. archived_at is orthogonal to status so the kanban
-- lane is preserved when a strategy is unarchived. All list/get queries filter archived
-- rows out by default; a partial index keeps the common "active" query fast.
ALTER TABLE "documents" ADD COLUMN IF NOT EXISTS "archived_at" timestamp with time zone;

CREATE INDEX IF NOT EXISTS "documents_account_active_idx"
  ON "documents" ("account_id")
  WHERE "archived_at" IS NULL;
