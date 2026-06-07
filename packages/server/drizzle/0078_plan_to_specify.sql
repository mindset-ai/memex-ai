-- spec-181 (dec-2): Full plan→specify phase rename — data migration slice.
--
-- The second Spec pipeline phase renames from `plan` to `specify`. The pipeline
-- becomes draft → specify → build → verify → done. Per dec-2 this is a SINGLE
-- atomic migration shipping with the code, following the spec-105 status-rename
-- pattern (0034_rename_mission_statuses): reshape the CHECK to admit the NEW
-- value first, then flip the rows.
--
-- Per dec-3 this migration issues ZERO statements against document_sections (or
-- any content/body column). The word "plan" survives untouched in section prose
-- — phase descriptions, "execution plan", and ordinary English alike. The rename
-- is a status/enum migration, not a prose rewrite.
--
-- Scope of the flip:
--   * documents.status                         'plan' → 'specify'
--   * org_scaffold_additions.target_phase      'plan' → 'specify'
--   * org_scaffold_additions.target_transition 'plan' → 'specify'
--
-- The documents_status_valid CHECK keeps the legacy values
-- (draft/review/implementation/done/approved) because execution-plan rows still
-- carry them — same union-of-old+new posture established in 0034. Only 'plan'
-- is swapped out for 'specify'.
--
-- Ordering: unlike 0034 (whose new CHECK was a superset of the old one, so it
-- could ADD-then-UPDATE), this rename is NOT a superset — the new CHECK admits
-- 'specify' but drops 'plan'. So we cannot ADD the new CHECK while 'plan' rows
-- still exist (ADD validates every row), nor UPDATE rows to 'specify' while the
-- old CHECK (no 'specify') is in force. The only valid order is
-- DROP → UPDATE → ADD: drop the constraint, flip the rows while the column is
-- unconstrained, then add the reshaped CHECK, which now validates cleanly
-- because no 'plan' remains. The whole sequence is atomic inside one
-- transaction, so the column is never observably unconstrained outside it.
--
-- Atomic: the whole file runs in one psql --single-transaction (the hand-
-- migration runner wraps it).
--
-- Revert: drizzle/reverts/0078_plan_to_specify.revert.sql restores 'plan' rows
-- and the original three CHECK constraints exactly.

BEGIN;

-- ════════════════════════════════════════════════════════════════════════
-- Step 1 — documents.status: drop the CHECK, flip rows, re-add the CHECK.
-- ════════════════════════════════════════════════════════════════════════
-- 'specify' replaces 'plan'; the legacy execution-plan values stay.
ALTER TABLE "documents" DROP CONSTRAINT "documents_status_valid";

UPDATE "documents" SET status = 'specify' WHERE status = 'plan';

ALTER TABLE "documents" ADD CONSTRAINT "documents_status_valid"
  CHECK (status IN ('draft', 'review', 'implementation', 'done', 'approved', 'specify', 'build', 'verify'));

-- ════════════════════════════════════════════════════════════════════════
-- Step 2 — org_scaffold_additions: drop the CHECKs, flip rows, re-add them.
-- ════════════════════════════════════════════════════════════════════════
ALTER TABLE "org_scaffold_additions" DROP CONSTRAINT "org_scaffold_additions_target_phase_valid";
ALTER TABLE "org_scaffold_additions" DROP CONSTRAINT "org_scaffold_additions_target_transition_valid";

UPDATE "org_scaffold_additions" SET target_phase = 'specify' WHERE target_phase = 'plan';
UPDATE "org_scaffold_additions" SET target_transition = 'specify' WHERE target_transition = 'plan';

ALTER TABLE "org_scaffold_additions" ADD CONSTRAINT "org_scaffold_additions_target_phase_valid"
  CHECK (target_phase IS NULL OR target_phase IN ('draft', 'specify', 'build', 'verify', 'done'));
ALTER TABLE "org_scaffold_additions" ADD CONSTRAINT "org_scaffold_additions_target_transition_valid"
  CHECK (target_transition IS NULL OR target_transition IN ('specify', 'build', 'verify', 'done'));

COMMIT;
