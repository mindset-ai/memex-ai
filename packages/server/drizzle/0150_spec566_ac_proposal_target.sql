-- spec-566 t-2 (ac-7, ac-8, ac-18, ac-20) — a comment can target an acceptance
-- criterion, so a supersession proposal has somewhere to live.
--
-- WHY A COLUMN AND NOT THE COMMENT BODY. dec-1 put AC supersession in the same
-- human-accept queue as standards proposals, which means the proposal IS a
-- `plan_revision` row in doc_comments. The only open question was which column
-- carries the target.
--
-- The cheap option was real: dec-6 makes the superseding DECISION ref mandatory,
-- so the proposal could have hung on the existing `decision_id` column and ridden
-- the Drift Inbox's existing COALESCE parent-doc join with no migration at all.
-- It loses on ONE ground: ac-20 requires the done-gate to NAME the criterion that
-- blocks the close. That is a QUERY — "which criteria on this Spec hold an
-- unaccepted proposal" — and under `decision_id` the AC ref would live only inside
-- the comment body's JSON payload. That is precisely the std-32 objection spec-566
-- made against a payload bag one task earlier (0149): a load-bearing field that a
-- gate filters on is a column. One Spec does not get to argue it both ways.
--
-- ON DELETE CASCADE matches the three target columns that already exist — a
-- comment whose target is gone has no subject. (Contrast `drift_decision_id`,
-- added by 0128, which is SET NULL because it is a CONTEXT link, not a target.
-- Note the same naming trap 0128 documented: `decision_id` is a TARGET column, so
-- spec-566's superseding-decision link cannot reuse it either; that link rides the
-- proposal payload, which is context, not the thing the gate filters on.)
--
-- ── STD-39, LOCK PROFILE — doc_comments is a hot table, so this is deliberate ──
--
--   1. ADD COLUMN: nullable with no default, so Postgres (11+) records the
--      addition in the catalog and does NOT rewrite the table. ACCESS EXCLUSIVE on
--      doc_comments for the catalog update only (sub-millisecond), plus a brief
--      SHARE ROW EXCLUSIVE on `acs` while the FK is created.
--   2. The CHECK is replaced via DROP + ADD ... NOT VALID, then VALIDATE in a
--      SEPARATE statement. Adding a validated CHECK directly would hold ACCESS
--      EXCLUSIVE for a FULL SCAN of doc_comments; NOT VALID takes the strong lock
--      only for the catalog write, and VALIDATE CONSTRAINT then scans under
--      SHARE UPDATE EXCLUSIVE, which does not block reads or writes.
--      VALIDATE is guaranteed to succeed here: the new constraint is strictly
--      WIDER than the one it replaces (it permits every combination the old one
--      permitted, plus ac_id), so every existing row already satisfies it.
--   3. The index is partial — only rows that actually carry an ac_id — so it costs
--      nothing on the write path for the overwhelming majority of comments.
--
-- GROWTH. One proposal per deliberate supersession. Rare by construction: this
-- Spec exists to make the act expensive.
--
-- RLS posture unchanged [std-36] — a column on the already-policied doc_comments.

ALTER TABLE "doc_comments"
  ADD COLUMN IF NOT EXISTS "ac_id" uuid REFERENCES "acs"("id") ON DELETE CASCADE;
--> statement-breakpoint

ALTER TABLE "doc_comments" DROP CONSTRAINT IF EXISTS "doc_comments_exactly_one_target";
--> statement-breakpoint

ALTER TABLE "doc_comments"
  ADD CONSTRAINT "doc_comments_exactly_one_target"
  CHECK (
    (CASE WHEN "section_id"  IS NOT NULL THEN 1 ELSE 0 END
     + CASE WHEN "decision_id" IS NOT NULL THEN 1 ELSE 0 END
     + CASE WHEN "task_id"     IS NOT NULL THEN 1 ELSE 0 END
     + CASE WHEN "ac_id"       IS NOT NULL THEN 1 ELSE 0 END) = 1
  ) NOT VALID;
--> statement-breakpoint

ALTER TABLE "doc_comments" VALIDATE CONSTRAINT "doc_comments_exactly_one_target";
--> statement-breakpoint

-- ac-20's read path: the done-gate asks "does this criterion hold an unaccepted
-- proposal". Partial on both predicates so the index carries only open proposals.
CREATE INDEX IF NOT EXISTS "doc_comments_open_ac_proposal_idx"
  ON "doc_comments" ("ac_id")
  WHERE "ac_id" IS NOT NULL AND "resolved_at" IS NULL;
