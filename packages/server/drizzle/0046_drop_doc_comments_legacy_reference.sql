-- doc-26 t-4 (part 2): drop the legacy opaque (reference_type, reference_id)
-- text pair on doc_comments. Migration 0045 added the four structured FK
-- columns + backfilled them from this pair, then t-5 switched the application
-- layer (services/comments.ts, routes/comments.ts, MCP add_comment, mcp
-- formatters) to read/write only the new columns. This drops the legacy
-- columns + the obsolete CHECK constraint.

ALTER TABLE "doc_comments" DROP CONSTRAINT IF EXISTS "doc_comments_reference_type_valid";
ALTER TABLE "doc_comments" DROP COLUMN IF EXISTS "reference_type";
ALTER TABLE "doc_comments" DROP COLUMN IF EXISTS "reference_id";
