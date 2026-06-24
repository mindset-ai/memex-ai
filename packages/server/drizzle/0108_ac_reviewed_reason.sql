-- spec-391 t-1 (ac-7): reviewed-verification rationale on ACs.
--
-- dec-2: the reviewed-verification AC class — dec-2's named, dated human
-- sign-off escape hatch for the hard verify→done AC gate — is modelled as an
-- EXTENSION of spec-188's manual-acceptance overlay (accepted_by/accepted_at,
-- migration 0078), NOT a new table or a new acs.kind value. A reviewed sign-off
-- is accepted_by + accepted_at + reviewed_reason set together; the reason makes
-- it a recognisable, REASONED class the gate and audit can name (why this AC
-- cannot carry an automated test — Stripe settings, Apple notarization, policy
-- ACs). The `accepted` verification state (deriveVerificationState) already
-- satisfies the gate; reviewed_reason is the only new field.
--
-- One nullable text column. acs already carries RLS (ENABLE + NO FORCE, policy
-- acs_memex_isolation; migrations 0081/0093) and the activity contract columns
-- (actor_user_id/actor_name/channel, std-32) — so no RLS or policy change here
-- [per std-36], no activity-contract column to add [per std-32].
--
-- Additive + reversible: one nullable column, no backfill, no constraint
-- change. Revert is DROP COLUMN reviewed_reason.
--
-- Idempotent (IF NOT EXISTS): the hand-migration runner wraps each file in a
-- transaction and tracks it in manual_migrations; the guard lets a retry
-- re-apply cleanly if a prior run committed the DDL but not the tracking row.

ALTER TABLE acs
  ADD COLUMN IF NOT EXISTS reviewed_reason text;
