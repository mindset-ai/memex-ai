-- spec-150 / develop-merge reconciliation: re-assert doc_sections.position NOT NULL.
--
-- 0072_add_doc_section_position added `position` as NOT NULL. Two things then left int
-- diverged:
--   1. The develop/branch migration-number collision (develop independently minted
--      0071/0072 for emission keys), so this branch's 0072 is filename-tracked and
--      will not re-run on int.
--   2. An int hotfix: `ALTER TABLE doc_sections ALTER COLUMN position DROP NOT NULL`
--      was applied manually to unblock create_doc while int's service still ran
--      develop's pre-position code (which inserts sections without `position`). That
--      was the dec-1 "code-first, then migrate" ordering inverted on int (accepted,
--      int-only).
--
-- This migration reconciles every environment back to the intended invariant: backfill
-- any NULL `position` from the identity `seq` (display == identity at creation,
-- spec-150 dec-2), then re-assert NOT NULL. Idempotent and safe everywhere — on an env
-- that is already NOT NULL the UPDATE touches 0 rows and SET NOT NULL is a no-op.
--
-- Additive and reversible: rollback is `ALTER TABLE doc_sections ALTER COLUMN position
-- DROP NOT NULL`.

UPDATE doc_sections SET position = seq WHERE position IS NULL;
ALTER TABLE doc_sections ALTER COLUMN position SET NOT NULL;
