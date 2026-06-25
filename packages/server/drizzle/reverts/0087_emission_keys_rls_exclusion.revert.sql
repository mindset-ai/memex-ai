-- Revert 0087_emission_keys_rls_exclusion.sql: re-apply RLS to
-- memex_emission_keys in its 0086 shape (nullif-guarded uuid cast).
-- WARNING: reverting re-breaks /api/test-events key verification under the
-- memex_app runtime role (the 2026-06-10 outage): only do this together with
-- a code change that gives the verify path a tenant-context-free lookup.
ALTER TABLE memex_emission_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE memex_emission_keys FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS memex_emission_keys_memex_isolation ON memex_emission_keys;
CREATE POLICY memex_emission_keys_memex_isolation ON memex_emission_keys
  USING (
    nullif(current_setting('app.memex_id', true), '') IS NOT NULL
    AND memex_id = nullif(current_setting('app.memex_id', true), '')::uuid
  )
  WITH CHECK (
    nullif(current_setting('app.memex_id', true), '') IS NOT NULL
    AND memex_id = nullif(current_setting('app.memex_id', true), '')::uuid
  );
