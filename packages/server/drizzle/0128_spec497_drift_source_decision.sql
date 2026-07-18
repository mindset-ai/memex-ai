-- spec-497 dec-3 (t-1) — first-class link from a drift comment to the decision
-- whose resolution triggered it, so the knowledge-graph endpoint can draw
-- decision→standard drift edges without re-parsing the comment prose at read time.
--
-- NAMING NOTE: doc_comments already has a `decision_id` column — that is the
-- comment's TARGET FK (a comment attached TO a decision), governed by the
-- doc_comments_exactly_one_target CHECK (exactly one of section_id / decision_id /
-- task_id). A drift comment's target is the standard SECTION (section_id set), so
-- the triggering decision cannot reuse that column. Hence a distinct
-- `drift_decision_id`. dec-3's intent — a nullable, first-class FK to the
-- triggering decision, SET NULL on delete — is preserved; only the name differs
-- to avoid the target-column collision.
--
-- Additive + nullable: existing drift rows come up NULL and are backfilled by
-- scripts/backfill-drift-decision.ts (t-3) where the prose parse resolves. RLS
-- posture unchanged — column on the already-policied doc_comments table (std-36).
-- ON DELETE SET NULL: deleting the decision degrades the edge to a node badge
-- (openDriftCount stays exact) rather than deleting the drift comment (history).
ALTER TABLE doc_comments
  ADD COLUMN IF NOT EXISTS drift_decision_id uuid REFERENCES decisions(id) ON DELETE SET NULL;

-- Partial index for the knowledge-graph drift-edge query: only drift comments
-- carry this column, and the edge query filters resolved_at IS NULL. Keep it
-- narrow so it costs nothing on the write path for non-drift comments.
CREATE INDEX IF NOT EXISTS doc_comments_drift_decision_idx
  ON doc_comments (memex_id, drift_decision_id)
  WHERE drift_decision_id IS NOT NULL AND resolved_at IS NULL;
