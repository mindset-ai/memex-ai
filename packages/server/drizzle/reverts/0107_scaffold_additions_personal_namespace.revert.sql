-- Revert spec-360 follow-up (0107_scaffold_additions_personal_namespace.sql).
-- Drops personal-namespace ownership of scaffold additions, restoring the
-- ORG-only posture. SAFE only when no personal-owned rows exist (org_id NULL):
-- the org_id NOT NULL restore below would fail otherwise.
DROP INDEX IF EXISTS org_scaffold_additions_namespace_id_memex_id_idx;
DROP INDEX IF EXISTS org_scaffold_additions_namespace_id_idx;
ALTER TABLE org_scaffold_additions DROP CONSTRAINT IF EXISTS org_scaffold_additions_owner_xor;
ALTER TABLE org_scaffold_additions DROP COLUMN IF EXISTS namespace_id;
ALTER TABLE org_scaffold_additions ALTER COLUMN org_id SET NOT NULL;
