-- spec-303 journey-state unblock: let a user SEE their own authored rows across
-- every memex, without relaxing tenant isolation for any write.
--
-- WHY
--   getUserMilestones() counts the acting user's OWN rows over documents/acs/
--   decisions. Those counts are USER-scoped and CROSS-memex ("has THIS user ever
--   authored a spec / resolved a decision / written an AC, anywhere"), so
--   /api/me/journey-state runs with no app.memex_id GUC. Under the runtime role
--   `memex_app` (non-owner, always subject to RLS — spec-257 dec-1) the memex-only
--   isolation policy filtered every count to ZERO: the Home Canvas ticks stayed
--   grey on int/prod though the data existed. Local/CI never caught it because
--   tests run as the table OWNER, which bypasses RLS (ENABLE + NO FORCE, 0093).
--
-- DESIGN — a SEPARATE `FOR SELECT` policy, NOT an edit to the FOR ALL one
--   The existing `<table>_memex_isolation` policy is FOR ALL (USING + WITH CHECK).
--   RLS routes commands differently: SELECT→USING, INSERT→WITH CHECK,
--   UPDATE→USING+WITH CHECK, DELETE→USING ONLY (there is no WITH CHECK for
--   DELETE). So widening that policy's USING with an own-row OR branch would also
--   widen DELETE — `memex_app` could delete its own authored rows across every
--   memex whenever app.user_id is set. That hole would rest on code discipline
--   ("only ever wrap reads in runWithUserId"), not on the database.
--
--   Instead we ADD a second, permissive, SELECT-only policy. Postgres OR-combines
--   permissive policies of the same command, so:
--     SELECT  → (memex USING) OR (owner USING)           ← widened, as intended
--     INSERT/UPDATE/DELETE → governed SOLELY by the untouched FOR ALL memex
--       policy. A row visible only via the owner policy is readable in a WHERE
--       but NOT updatable or deletable (the FOR ALL USING/WITH CHECK still gate
--       the write target → zero rows, no error, no hole).
--   The FOR ALL `<table>_memex_isolation` policies are left byte-for-byte intact
--   (so 0086's safe-uuid-cast is preserved untouched).
--
-- SAFE UUID CAST: the new clause uses nullif(current_setting(...,true),'')::uuid
--   so an unset/empty GUC yields NULL (row blocked) instead of throwing
--   "invalid input syntax for type uuid" — same guard 0086 established.
--
-- SCOPE: only the three tables journey-state reads (documents, acs, decisions).
--   The broader "see every row in memexes you're a member of" membership model is
--   a separate, security-critical re-key (its own Spec), not this unblock.
--
-- INDEXES: current_setting() is STABLE, not IMMUTABLE, so the planner cannot fold
--   the owner predicate to constant-false at plan time — it stays in the plan.
--   Add partial btree indexes on the owner columns so the journey counts under
--   memex_app use an index instead of seq-scanning all three tables.

-- ── owner-visibility SELECT policies (additive; co-exist with memex_isolation) ──
DROP POLICY IF EXISTS documents_owner_visibility ON documents;
CREATE POLICY documents_owner_visibility ON documents
  FOR SELECT
  USING (
    nullif(current_setting('app.user_id', true), '') IS NOT NULL
    AND created_by_user_id = nullif(current_setting('app.user_id', true), '')::uuid
  );

DROP POLICY IF EXISTS acs_owner_visibility ON acs;
CREATE POLICY acs_owner_visibility ON acs
  FOR SELECT
  USING (
    nullif(current_setting('app.user_id', true), '') IS NOT NULL
    AND actor_user_id = nullif(current_setting('app.user_id', true), '')::uuid
  );

DROP POLICY IF EXISTS decisions_owner_visibility ON decisions;
CREATE POLICY decisions_owner_visibility ON decisions
  FOR SELECT
  USING (
    nullif(current_setting('app.user_id', true), '') IS NOT NULL
    AND actor_user_id = nullif(current_setting('app.user_id', true), '')::uuid
  );

-- ── owner-column indexes (partial: the predicate is equality on a NOT-NULL id) ──
CREATE INDEX IF NOT EXISTS documents_created_by_user_id_idx
  ON documents (created_by_user_id) WHERE created_by_user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS acs_actor_user_id_idx
  ON acs (actor_user_id) WHERE actor_user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS decisions_actor_user_id_idx
  ON decisions (actor_user_id) WHERE actor_user_id IS NOT NULL;
