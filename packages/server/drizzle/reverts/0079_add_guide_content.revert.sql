-- Revert of 0079_add_guide_content.sql (spec-190 t-6).
-- Drops the voice guide's knowledge store. The corpus is re-imported from
-- guide-content/ markdown on the next deploy (db:import-guide-content), so no
-- data is permanently lost — the source of truth is the repo, not the table.

DROP TABLE IF EXISTS "guide_content";
