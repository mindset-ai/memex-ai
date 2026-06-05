-- Add per-document lifecycle timestamps (doc-12 t-1).
--
-- Both columns are nullable timestamptz with no DB default — the convention for
-- lifecycle flags on documents (see archived_at in 0023). NULL is the implicit
-- "off" / "never" state, a non-null timestamp records when the state was entered.
--
--   paused_at                       NULL = active, set = paused. Mission-only;
--                                   paused Missions stop receiving agent work but
--                                   stay visible in their kanban lane. Orthogonal
--                                   to status (and to archived_at) so the lane is
--                                   preserved when un-paused.
--
--   narrative_last_consolidated_at  NULL = never consolidated. Mission-only.
--                                   Updated by the agent when it consolidates the
--                                   Mission narrative. Used to surface "last
--                                   consolidated N days ago" + drive consolidation
--                                   prompts.
--
-- No data backfill: existing rows default to NULL, which is the correct
-- starting state for both ("not paused", "never consolidated").

ALTER TABLE documents
  ADD COLUMN IF NOT EXISTS paused_at timestamp with time zone,
  ADD COLUMN IF NOT EXISTS narrative_last_consolidated_at timestamp with time zone;
