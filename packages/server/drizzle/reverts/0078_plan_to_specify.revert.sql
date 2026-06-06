-- Revert spec-181 (0078_plan_to_specify): restore the `plan` phase.
--
-- Inverse of the forward migration. Restores 'specify' rows back to 'plan' on
-- documents.status, org_scaffold_additions.target_phase, and
-- org_scaffold_additions.target_transition, and re-establishes the original
-- three CHECK constraints exactly as they stood before 0078 (the union that
-- still carried 'plan', not 'specify').
--
-- Per dec-3 the forward migration touched no content/body column, so there is
-- nothing prose-side to undo — this revert is purely the status/enum inverse.
--
-- Ordering: mirrors the forward file's DROP → UPDATE → ADD. The rename is not a
-- superset in either direction, so we cannot re-add the 'plan'-admitting CHECK
-- while 'specify' rows still exist, nor UPDATE rows to 'plan' while the post-0078
-- CHECK (no 'plan') is in force. So: drop the post-0078 CHECK, flip the rows back
-- to 'plan' while the column is unconstrained, then re-add the original CHECK,
-- which validates cleanly because no 'specify' remains.
--
-- Reverts are NOT auto-applied by the hand-migration runner — run manually with
-- psql against the target DB only if a regression forces a rollback.

BEGIN;

-- ════════════════════════════════════════════════════════════════════════
-- Step 1 — documents.status: drop the CHECK, flip rows back, re-add original.
-- ════════════════════════════════════════════════════════════════════════
ALTER TABLE "documents" DROP CONSTRAINT "documents_status_valid";

UPDATE "documents" SET status = 'plan' WHERE status = 'specify';

ALTER TABLE "documents" ADD CONSTRAINT "documents_status_valid"
  CHECK (status IN ('draft', 'review', 'implementation', 'done', 'approved', 'plan', 'build', 'verify'));

-- ════════════════════════════════════════════════════════════════════════
-- Step 2 — org_scaffold_additions: drop CHECKs, flip rows back, re-add originals.
-- ════════════════════════════════════════════════════════════════════════
ALTER TABLE "org_scaffold_additions" DROP CONSTRAINT "org_scaffold_additions_target_phase_valid";
ALTER TABLE "org_scaffold_additions" DROP CONSTRAINT "org_scaffold_additions_target_transition_valid";

UPDATE "org_scaffold_additions" SET target_phase = 'plan' WHERE target_phase = 'specify';
UPDATE "org_scaffold_additions" SET target_transition = 'plan' WHERE target_transition = 'specify';

ALTER TABLE "org_scaffold_additions" ADD CONSTRAINT "org_scaffold_additions_target_phase_valid"
  CHECK (target_phase IS NULL OR target_phase IN ('draft', 'plan', 'build', 'verify', 'done'));
ALTER TABLE "org_scaffold_additions" ADD CONSTRAINT "org_scaffold_additions_target_transition_valid"
  CHECK (target_transition IS NULL OR target_transition IN ('plan', 'build', 'verify', 'done'));

COMMIT;
