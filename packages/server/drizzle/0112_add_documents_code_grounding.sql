-- spec-409 t-1 (ac-6): add the "code-grounded" flag + provenance to documents.
--
-- A Spec is grounded when an agent has verified its resolved decisions against
-- the actual codebase. Standalone Spec-level boolean (dec-1) — NOT derived from
-- spec-76's per-node grounded_against (which is draft, no code). Set only via the
-- `ground_spec` MCP tool over channel='mcp' with a `codebase_present` assertion
-- (dec-3). Provenance is stamped at write (dec-2): grounded_by_name is
-- denormalised per std-32 so a later rename can't rewrite history. Staleness is
-- computed at read time (decision/AC updated_at > grounded_at, dec-4) and never
-- written here.
--
-- Additive + reversible. grounded_in_code is a NOT NULL boolean with a safe
-- default (false) — every existing document reads as not grounded, which is
-- correct. The provenance columns are nullable (no backfill): a not-grounded doc
-- has no grounder. The revert is DROP COLUMN on all four.
--
-- Idempotent (IF NOT EXISTS): the hand-migration runner wraps each file in a
-- transaction and tracks it in manual_migrations; the guards let a retry re-apply
-- cleanly if a prior run committed the DDL but not the tracking row.

ALTER TABLE documents
  ADD COLUMN IF NOT EXISTS grounded_in_code boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS grounded_at timestamptz,
  ADD COLUMN IF NOT EXISTS grounded_by_user_id uuid,
  ADD COLUMN IF NOT EXISTS grounded_by_name text;
