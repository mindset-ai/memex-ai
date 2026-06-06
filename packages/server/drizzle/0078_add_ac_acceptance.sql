-- spec-188 t-1 (ac-6, ac-8): manual verification acceptance on ACs.
--
-- dec-1/dec-2: a human can mark an AC as accepted when it cannot be exercised
-- by a digital test. The acceptance is an audited OVERLAY on the test-derived
-- verification state, stored on the acs row itself:
--   accepted_by — display snapshot of who accepted (user.name ?? email), same
--                 posture as test_events.actor: attribution survives user
--                 deletion, no FK.
--   accepted_at — when. Both NULL = no acceptance (the default for all
--                 existing rows, which is correct — nothing has been manually
--                 accepted yet).
--
-- Evidence wins (dec-2): the derivation in services/acs.ts suppresses the
-- acceptance while any failing test evidence exists — the columns are never
-- auto-cleared. Un-accept nulls both columns.
--
-- Additive + reversible: two nullable columns, no backfill, no constraint
-- changes. Revert is DROP COLUMN both.
--
-- Idempotent (IF NOT EXISTS): the hand-migration runner wraps each file in a
-- transaction and tracks it in manual_migrations; the guard lets a retry
-- re-apply cleanly if a prior run committed the DDL but not the tracking row.

ALTER TABLE acs
  ADD COLUMN IF NOT EXISTS accepted_by text,
  ADD COLUMN IF NOT EXISTS accepted_at timestamp with time zone;
