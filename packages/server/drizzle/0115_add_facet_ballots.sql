-- spec-423 t-1 / t-4 (phase 2, the consume side): the ballot + routing-log substrate.
--
-- Three tables — the CONSUME side:
--   1. task_facet_ballots     — the per-task forced full ballot (dec-5/dec-7). Memex-scoped.
--   2. decision_facet_ballots — the per-decision forced full ballot (dec-5/dec-6/dec-7). Memex-scoped.
--   3. facet_routing_log      — append-only routing telemetry, one row per routing call (dec-4).
--
-- The produce-side tables (facets, standard_clause_facets) live in 0114 (spec-340 phase 1).
--
-- Named UNIQUE / index / policy names match the Drizzle schema's
-- unique()/index()/uniqueIndex() names so introspection-by-conname stays in lockstep.
-- Idempotent (IF NOT EXISTS) so the hand-migration runner re-applies cleanly.

-- 1. task_facet_ballots — the per-task forced full ballot (dec-5/dec-7) ----------------
--
-- One row per task. `verdict` is the COMPLETE boolean map keyed on each facet's stable
-- slug (full map, not sparse — so "ruled out" ≠ "never considered"). `none` true =
-- honest no-facet work. Record-absent (no row) = not-yet-classified; record-present =
-- classified. `vocabulary_keys` snapshots the slugs the ballot was cast against, so
-- completeness is judged at cast time (dec-7). Ballots anchor on facet KEYS (strings),
-- never owner ids, so they are owner-model-agnostic (spec-340 dec-7 polymorphic owner).
-- std-32: actor_user_id + denormalised actor_name + channel, stamped at write.
-- Memex-scoped → memex_isolation RLS (std-36, ENABLE not FORCE).
CREATE TABLE IF NOT EXISTS task_facet_ballots (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  memex_id        UUID NOT NULL,
  task_id         UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  verdict         JSONB NOT NULL,
  none            BOOLEAN NOT NULL DEFAULT false,
  vocabulary_keys JSONB NOT NULL,
  actor_user_id   UUID REFERENCES users(id) ON DELETE SET NULL,
  actor_name      TEXT,
  channel         TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT task_facet_ballots_task_id_unique UNIQUE (task_id)
);

CREATE INDEX IF NOT EXISTS task_facet_ballots_memex_id_idx ON task_facet_ballots (memex_id);

ALTER TABLE task_facet_ballots ENABLE ROW LEVEL SECURITY;
ALTER TABLE task_facet_ballots NO FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS task_facet_ballots_memex_isolation ON task_facet_ballots;
CREATE POLICY task_facet_ballots_memex_isolation ON task_facet_ballots
  USING (
    nullif(current_setting('app.memex_id', true), '') IS NOT NULL
    AND memex_id = current_setting('app.memex_id', true)::uuid
  )
  WITH CHECK (
    nullif(current_setting('app.memex_id', true), '') IS NOT NULL
    AND memex_id = current_setting('app.memex_id', true)::uuid
  );

GRANT SELECT, INSERT, UPDATE, DELETE ON task_facet_ballots TO memex_app;

-- 2. decision_facet_ballots — the per-decision forced full ballot (dec-5/dec-6/dec-7) --
--
-- Identical shape to task_facet_ballots, on decisions. dec-6: a decision's ballot is a
-- WORK-SIDE routing hook only — it routes the governing STANDARDS, and is NEVER surfaced
-- as binding precedent. So this is work-side ballot data (like tasks), never a content
-- corpus the router reads from.
CREATE TABLE IF NOT EXISTS decision_facet_ballots (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  memex_id        UUID NOT NULL,
  decision_id     UUID NOT NULL REFERENCES decisions(id) ON DELETE CASCADE,
  verdict         JSONB NOT NULL,
  none            BOOLEAN NOT NULL DEFAULT false,
  vocabulary_keys JSONB NOT NULL,
  actor_user_id   UUID REFERENCES users(id) ON DELETE SET NULL,
  actor_name      TEXT,
  channel         TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT decision_facet_ballots_decision_id_unique UNIQUE (decision_id)
);

CREATE INDEX IF NOT EXISTS decision_facet_ballots_memex_id_idx ON decision_facet_ballots (memex_id);

ALTER TABLE decision_facet_ballots ENABLE ROW LEVEL SECURITY;
ALTER TABLE decision_facet_ballots NO FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS decision_facet_ballots_memex_isolation ON decision_facet_ballots;
CREATE POLICY decision_facet_ballots_memex_isolation ON decision_facet_ballots
  USING (
    nullif(current_setting('app.memex_id', true), '') IS NOT NULL
    AND memex_id = current_setting('app.memex_id', true)::uuid
  )
  WITH CHECK (
    nullif(current_setting('app.memex_id', true), '') IS NOT NULL
    AND memex_id = current_setting('app.memex_id', true)::uuid
  );

GRANT SELECT, INSERT, UPDATE, DELETE ON decision_facet_ballots TO memex_app;

-- 3. facet_routing_log — append-only routing telemetry (dec-4) ------------------------
--
-- One row per routing call on create_task / resolve_decision. Captures query text, the
-- full candidate set with ALL scores, the surfaced-vs-cut split (k + params), the ranker
-- model/version, the owning ref, and a timestamp. Append-only; OFF the SSE bus
-- (telemetry-log posture, std-8 silent-allowed — same category as mcp-telemetry /
-- activity-log writers). The substrate to tune K from real traffic and build a clean
-- relevance gold set later. Memex-scoped → memex_isolation RLS (std-36).
CREATE TABLE IF NOT EXISTS facet_routing_log (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  memex_id      UUID NOT NULL,
  -- The owning work ref (task/decision canonical ref) the routing was run for.
  owner_ref     TEXT NOT NULL,
  -- 'task' | 'decision' — which hook ran the routing.
  noun          TEXT NOT NULL,
  -- The text routed against (the work's title/description/resolution).
  query_text    TEXT NOT NULL,
  -- The TRUE facet keys the ballot routed on.
  facet_keys    JSONB NOT NULL,
  -- The FULL candidate set with all scores + the surfaced flag:
  -- [{ handle, title, score, surfaced }]. Nothing pruned before logging (dec-2).
  candidates    JSONB NOT NULL,
  -- The attention cap applied (top-K).
  k             INTEGER NOT NULL,
  -- Ranker provenance: 'cohere' | 'keyless-density', + version/model where available.
  ranker_model  TEXT NOT NULL,
  ranker_params JSONB,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS facet_routing_log_memex_id_idx  ON facet_routing_log (memex_id);
CREATE INDEX IF NOT EXISTS facet_routing_log_created_at_idx ON facet_routing_log (created_at);

ALTER TABLE facet_routing_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE facet_routing_log NO FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS facet_routing_log_memex_isolation ON facet_routing_log;
CREATE POLICY facet_routing_log_memex_isolation ON facet_routing_log
  USING (
    nullif(current_setting('app.memex_id', true), '') IS NOT NULL
    AND memex_id = current_setting('app.memex_id', true)::uuid
  )
  WITH CHECK (
    nullif(current_setting('app.memex_id', true), '') IS NOT NULL
    AND memex_id = current_setting('app.memex_id', true)::uuid
  );

GRANT SELECT, INSERT, UPDATE, DELETE ON facet_routing_log TO memex_app;
