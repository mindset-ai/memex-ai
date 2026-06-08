-- Revert spec-213 t-1 (0083_backfill_users_onboarding_greeted_at.sql).
--
-- Intentionally a NO-OP. The backfill is a one-way data correction: it stamped
-- onboarding_greeted_at = now() on every previously-null row. Once stamped, a
-- backfilled row is indistinguishable from a row stamped by a genuine greeting,
-- so there is no safe predicate to undo only the backfilled rows. Blanket-nulling
-- the column would wrongly re-greet users who were legitimately greeted. If the
-- column itself ever needs removing, that is the concern of 0082's revert
-- (DROP COLUMN), not this data migration.
SELECT 1;
