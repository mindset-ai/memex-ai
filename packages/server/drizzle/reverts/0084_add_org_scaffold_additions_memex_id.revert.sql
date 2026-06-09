-- Revert spec-193 t-5 (0084_add_org_scaffold_additions_memex_id.sql).
DROP INDEX IF EXISTS org_scaffold_additions_org_id_memex_id_idx;
ALTER TABLE org_scaffold_additions DROP COLUMN IF EXISTS memex_id;
