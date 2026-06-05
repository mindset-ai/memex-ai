-- spec-100 (geo-comments): anchor a comment to a point in a section's markdown.
--
-- Three additive, nullable/defaulted columns on doc_comments. The marker glyph
-- that rides in the section source is the comment's own `c-{seq}` handle in
-- footnote form (`[^c-{seq}]`, dec-1), so no separate marker-id column is
-- needed — seq is already on the row and is stable for the comment's lifetime.
--
--   anchor_snippet — snapshot of the surrounding text captured at creation
--                    (dec-4: store the snapshot, render live alongside it).
--                    NULL means the comment is floating, which is the historic
--                    behaviour for every existing row — no backfill required.
--   audience       — reserved for v1+ attention routing. v0 always writes the
--                    JSON string "all". jsonb (not text) so v1 can start
--                    writing a userId[] without a follow-up migration.
--   actions        — system-authored action buttons (Address/Dismiss). jsonb
--                    array of { label, kind, prompt? }. NULL on human comments;
--                    `kind` is an open string so v2 'route' adds without a
--                    migration.
--
-- `source` already distinguishes 'human' | 'agent' (the spec's "authorKind"),
-- so no new author-kind column is added — agent == system-authored.
--
-- Additive + reversible (revert in drizzle/reverts/). IF NOT EXISTS so the
-- hand-migration runner can re-apply cleanly across environments.

ALTER TABLE doc_comments
  ADD COLUMN IF NOT EXISTS anchor_snippet text,
  ADD COLUMN IF NOT EXISTS audience jsonb NOT NULL DEFAULT '"all"'::jsonb,
  ADD COLUMN IF NOT EXISTS actions jsonb;
