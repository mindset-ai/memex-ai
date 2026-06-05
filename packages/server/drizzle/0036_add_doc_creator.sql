-- Add documents.created_by_user_id so the Missions kanban can render a creator
-- name on each card. Nullable + ON DELETE SET NULL: existing rows survive (the
-- React UI falls back to "Unknown" when null), and removing a user doesn't
-- cascade-delete or block-delete the docs they created.

ALTER TABLE documents
  ADD COLUMN created_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL;
