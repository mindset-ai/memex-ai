-- spec-151 dec-7 (t-8) — the adversarial-verification record for clause tests.
--
-- A clause test's green/red is not trusted until an INDEPENDENT verifier confirms
-- the test genuinely + universally asserts its clause (the spike measured a ~25%
-- first-draft defect rate). This table holds that verdict per (clause ref,
-- test_identifier); the clause-coverage read gates on it (no confirmed verdict →
-- "pending", neither green nor red — ac-20; a rejected verdict never confirms — ac-21).
--
-- COST/LOCKS (std-39): a fresh CREATE TABLE — no lock on existing tables, no rewrite.
-- Idempotent (IF NOT EXISTS) so a re-run is a no-op.

CREATE TABLE IF NOT EXISTS clause_test_verifications (
  subject_ref      text NOT NULL,
  test_identifier  text NOT NULL DEFAULT '',
  verdict          text NOT NULL,
  verifier         text,
  reason           text,
  memex_id         uuid NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT clause_test_verifications_pkey PRIMARY KEY (subject_ref, test_identifier),
  CONSTRAINT clause_test_verifications_verdict_valid CHECK (verdict IN ('confirmed', 'rejected'))
);

CREATE INDEX IF NOT EXISTS clause_test_verifications_memex_id_idx
  ON clause_test_verifications (memex_id);
