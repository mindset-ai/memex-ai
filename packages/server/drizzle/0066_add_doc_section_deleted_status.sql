-- spec-107 t-1: extend doc_sections with a soft-delete lifecycle.
--
-- Two new columns, mirroring the decisions soft-delete precedent (0064, b-97):
--   1. `status` (text, NOT NULL, default 'active'). delete_section flips this to
--      'deleted'; every read path (get_doc, lists, render, FTS + vector search)
--      filters `status != 'deleted'`.
--   2. `previous_status` (nullable text). Captures the status held at the moment
--      delete_section was called so the update/restore path can return the
--      section to it without the caller remembering.
--
-- A `doc_sections_status_valid` CHECK constrains status to the known set. No data
-- backfill is required: the default 'active' applies to every existing row, and
-- previous_status NULL is correct for rows that have never been deleted.
--
-- Idempotent (IF [NOT] EXISTS / DROP+ADD): some environments may already carry
-- these columns from an earlier touch not recorded in `manual_migrations`, so
-- each step is guarded to let the hand-migration runner re-apply cleanly.

ALTER TABLE doc_sections
  ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'active';

ALTER TABLE doc_sections
  ADD COLUMN IF NOT EXISTS previous_status text;

ALTER TABLE doc_sections
  DROP CONSTRAINT IF EXISTS doc_sections_status_valid;

ALTER TABLE doc_sections
  ADD CONSTRAINT doc_sections_status_valid
    CHECK (status IN ('active', 'deleted'));

-- Make the per-doc seq uniqueness PARTIAL: a soft-deleted section keeps its seq
-- value, but must not occupy a live ordering slot — otherwise resequencing the
-- tail on delete (shifting live rows down by one) collides with the frozen seq of
-- the row just deleted. Excluding deleted rows from the unique index lets the live
-- sequence stay contiguous (dec-3) while the deleted row's seq dangles harmlessly
-- until restore. The index keeps the same NAME as the old constraint so
-- addSection's withSeqRetry conflict detection (which matches on the name
-- `doc_sections_doc_seq_unique`) keeps working unchanged.
ALTER TABLE doc_sections
  DROP CONSTRAINT IF EXISTS doc_sections_doc_seq_unique;

DROP INDEX IF EXISTS doc_sections_doc_seq_unique;

CREATE UNIQUE INDEX IF NOT EXISTS doc_sections_doc_seq_unique
  ON doc_sections (doc_id, seq)
  WHERE status <> 'deleted';
