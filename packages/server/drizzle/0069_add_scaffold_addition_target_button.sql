-- spec-103 t-3: per-Org scaffold guidance additions can target a Prompt Button.
--
-- Adds the `target_button` dimension to org_scaffold_additions so a
-- `source: 'org'` GuidanceBlock can attach to a specific Prompt Button id
-- (spec-103 D-7). It rolls up into the `target: { ..., button? }` shape at the
-- service-read mapping layer, exactly like target_phase/target_tool/
-- target_transition. NULL = not a button-targeted block.
--
-- Unlike the phase/transition dimensions, a button id is a FREE-FORM slug
-- (e.g. 'verify-spec'), NOT an enum — so there is deliberately NO CHECK
-- constraint here, just a nullable TEXT column. (This also sidesteps the known
-- Postgres auto-named-CHECK / Drizzle check()-name drift gotcha.)

ALTER TABLE org_scaffold_additions
  ADD COLUMN target_button TEXT;

-- Extend the composite target lookup index to carry the new dimension so
-- button-targeted reads stay index-covered (mirrors the Drizzle schema).
DROP INDEX IF EXISTS org_scaffold_additions_org_id_target_idx;
CREATE INDEX org_scaffold_additions_org_id_target_idx
  ON org_scaffold_additions (org_id, target_phase, target_tool, target_transition, target_button);
