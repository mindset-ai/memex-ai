-- spec-360 follow-up: let a PERSONAL namespace own scaffold guidance additions.
--
-- Today org_scaffold_additions is ORG-only (org_id NOT NULL → orgs). A personal
-- namespace (namespaces.kind='user', owned by owner_user_id, NO org) therefore
-- cannot carry additions, so the Scaffold page is explain-only there. This
-- generalises ownership to "org OR personal namespace" (additive namespace
-- ownership): a row is owned by exactly one of org_id / namespace_id.
--
-- WHAT
--   - org_id becomes NULLABLE (a personal-owned row has org_id NULL).
--   - namespace_id added — a NULLABLE uuid FK to namespaces, ON DELETE CASCADE
--     (deleting the namespace drops its additions, mirroring the org cascade).
--   - XOR CHECK: exactly one of (org_id, namespace_id) is set — a row is owned
--     by an org OR a personal namespace, never both, never neither. Every
--     existing row has org_id set + namespace_id NULL, which satisfies the XOR
--     unchanged, so behaviour is preserved.
--   - indexes on (namespace_id) and (namespace_id, memex_id) so the personal
--     read path (`WHERE namespace_id = ? [AND (memex_id IS NULL OR = ?)]`)
--     stays an index scan, mirroring the org_id / (org_id, memex_id) pair.
--
-- Additive + reversible (see reverts/0107_*.revert.sql).
--
-- Idempotent (IF NOT EXISTS / DO-block guards): the hand-migration runner wraps
-- each file in a transaction and tracks it in manual_migrations; the guards let
-- a retry re-apply cleanly if a prior run committed the DDL but not the tracking
-- row.

ALTER TABLE org_scaffold_additions
  ALTER COLUMN org_id DROP NOT NULL;

ALTER TABLE org_scaffold_additions
  ADD COLUMN IF NOT EXISTS namespace_id uuid REFERENCES namespaces(id) ON DELETE CASCADE;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'org_scaffold_additions_owner_xor'
  ) THEN
    ALTER TABLE org_scaffold_additions
      ADD CONSTRAINT org_scaffold_additions_owner_xor
      CHECK ((org_id IS NOT NULL) <> (namespace_id IS NOT NULL));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS org_scaffold_additions_namespace_id_idx
  ON org_scaffold_additions (namespace_id);

CREATE INDEX IF NOT EXISTS org_scaffold_additions_namespace_id_memex_id_idx
  ON org_scaffold_additions (namespace_id, memex_id);
