-- spec-206 t-1 (dec-3 / ac-12): add onboarding_greeted_at to the users table.
--
-- The server-authoritative first-run flag for the Specky welcome (spec-206).
-- Null = the user has never been greeted; a timestamp = the first session where
-- Specky's opening turn actually started speaking (dec-4 stamps it only once the
-- voice session reaches `active`, so a blocked/denied mic does not consume the
-- one-shot). True once-per-user across devices — the auto-greeting never re-fires.
--
-- Additive + reversible: a single NULLABLE timestamptz with no default. Every
-- existing row gets null, which is correct — no existing user has been greeted by
-- the new flow, so they all become eligible exactly once. The revert is DROP COLUMN.
--
-- Idempotent (IF NOT EXISTS): the hand-migration runner wraps each file in a
-- transaction and tracks it in manual_migrations; the guard lets a retry re-apply
-- cleanly if a prior run committed the DDL but not the tracking row.

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS onboarding_greeted_at timestamptz;
