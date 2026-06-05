-- Align doc_comments.reference_type CHECK constraint with the Strategy → Mission
-- rename (t-4 follow-up). Background: 0028 renamed documents.doc_type
-- 'strategy' → 'mission'. The cross-reference target enum on doc_comments
-- carried the same legacy value, and the React UI's COMMENT_REFERENCE_TYPES
-- already exposes 'mission' — so the server-side allowlist needs to match.
--
-- Post-merge note (doc-5 ↔ main): main's version of this migration listed
-- 'work_item' alongside 'mission'/'decision'/'blueprint'. doc-5's 0028
-- (revert_to_tasks) already converted 'work_item' rows back to 'task' and
-- collapsed the noun back to "task" everywhere. So the final allowlist here
-- is ('task', 'mission', 'decision', 'blueprint') — which matches both the
-- doc_comments.task_id column rename in 0028 and types/roles.ts.
--
-- Steps:
--   1. Drop the existing CHECK constraint that enumerates the legacy values.
--   2. UPDATE any in-flight rows that still have reference_type='strategy'
--      to 'mission' (none expected on int — the docType migration ran first
--      and cross-reference rows are agent-emitted from current code — but the
--      UPDATE keeps the migration safe to replay against any environment).
--   3. UPDATE any 'work_item' → 'task' rows defensively (0028 already does
--      this, but applying this migration in isolation against a stale DB
--      should still produce a valid state).
--   4. Re-add the CHECK with the new allowlist.

ALTER TABLE "doc_comments" DROP CONSTRAINT IF EXISTS "doc_comments_reference_type_valid";

UPDATE "doc_comments" SET "reference_type" = 'mission' WHERE "reference_type" = 'strategy';
UPDATE "doc_comments" SET "reference_type" = 'task' WHERE "reference_type" = 'work_item';

ALTER TABLE "doc_comments" ADD CONSTRAINT "doc_comments_reference_type_valid"
  CHECK ("reference_type" IS NULL OR "reference_type" IN ('task', 'mission', 'decision', 'blueprint'));
