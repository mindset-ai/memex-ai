-- Revert spec-100: drop the three geo-comment columns from doc_comments.
--
-- Additive forward migration → trivial reverse. anchor_snippet / audience /
-- actions are all opt-in: dropping them returns every comment to floating,
-- human-discussable, no-actions behaviour — the pre-spec-100 shape. Any
-- in-source `[^c-N]` marker glyphs become inert footnote references on revert.

ALTER TABLE doc_comments
  DROP COLUMN IF EXISTS anchor_snippet,
  DROP COLUMN IF EXISTS audience,
  DROP COLUMN IF EXISTS actions;
