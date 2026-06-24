-- spec-340 t-1: the facet substrate — a cross-cutting practice-area vocabulary
-- that routes work to its governing standards and is exhaustively adjudicated at
-- task creation.
--
-- Three tables:
--   1. facets                 — the org-owned vocabulary (dec-7). Org-scoped.
--   2. standard_clause_facets — clause→facet tags, auto-assigned (dec-2). Memex-scoped.
--   3. task_facet_ballots     — the per-task forced full ballot (dec-5). Memex-scoped.
--
-- Named CHECK / UNIQUE / index names match the Drizzle schema's
-- unique()/index()/uniqueIndex() names so introspection-by-conname stays in
-- lockstep. Idempotent (IF NOT EXISTS) so the hand-migration runner re-applies cleanly.

-- 1. facets — the org-owned vocabulary (dec-7) ---------------------------------------
--
-- Org-scoped, like org_scaffold_additions: each org gets its own copy of the default
-- 16 (seeded at provisioning, t-2), editable by data. It carries NO memex_id, so it
-- takes NO memex_isolation RLS policy — a row could never satisfy a memex_id=GUC
-- predicate; org-membership access is gated at the service layer. Uniqueness is
-- per-org (org_id, key), NOT global, so two orgs diverge freely. `key` is the stable
-- slug ballots/tags anchor on (never rewritten by a display rename, dec-5); `name` is
-- the renameable display override; `description` is the REQUIRED classifier rubric.
CREATE TABLE IF NOT EXISTS facets (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  key         TEXT NOT NULL,
  name        TEXT,
  description TEXT NOT NULL,
  ord         INTEGER NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT facets_org_id_key_unique UNIQUE (org_id, key)
);

CREATE INDEX IF NOT EXISTS facets_org_id_idx ON facets (org_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON facets TO memex_app;

-- 2. standard_clause_facets — clause→facet tags (dec-2) ------------------------------
--
-- Auto-assigned by the classifier at authoring time (NOT a hand-maintained join — the
-- distinction the spec-193 guard reconciliation rides, t-9). Memex-scoped: rides the
-- standards corpus. The tri-state the design requires (explicit "governs nothing"
-- distinguishable from "not yet classified") is encoded by the nullable facet_id:
--   • NO rows for a clause            → not-yet-classified
--   • exactly one row, facet_id NULL  → explicit "governs nothing"
--   • one row per member facet         → governs those facets
-- Standard-level pills are the union over member rows only.
CREATE TABLE IF NOT EXISTS standard_clause_facets (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  memex_id   UUID NOT NULL,
  clause_id  UUID NOT NULL REFERENCES standard_clauses(id) ON DELETE CASCADE,
  facet_id   UUID REFERENCES facets(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- At most one membership row per (clause, facet); at most one explicit-none marker per clause.
CREATE UNIQUE INDEX IF NOT EXISTS standard_clause_facets_clause_facet_unique
  ON standard_clause_facets (clause_id, facet_id) WHERE facet_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS standard_clause_facets_clause_none_unique
  ON standard_clause_facets (clause_id) WHERE facet_id IS NULL;
CREATE INDEX IF NOT EXISTS standard_clause_facets_clause_id_idx ON standard_clause_facets (clause_id);
CREATE INDEX IF NOT EXISTS standard_clause_facets_facet_id_idx  ON standard_clause_facets (facet_id);
CREATE INDEX IF NOT EXISTS standard_clause_facets_memex_id_idx  ON standard_clause_facets (memex_id);

-- Tenancy (std-36): direct memex_id, so the memex_isolation policy applies. ENABLED but
-- NOT FORCED (spec-257 dec-1, migration 0093) — FORCE bites the owner role `postgres`
-- used by migrations/deploys; NO FORCE lets the owner bypass while the runtime role
-- memex_app stays subject to RLS. The spec-199 RLS guard fails CI on any FORCE'd table.
ALTER TABLE standard_clause_facets ENABLE ROW LEVEL SECURITY;
ALTER TABLE standard_clause_facets NO FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS standard_clause_facets_memex_isolation ON standard_clause_facets;
CREATE POLICY standard_clause_facets_memex_isolation ON standard_clause_facets
  USING (
    nullif(current_setting('app.memex_id', true), '') IS NOT NULL
    AND memex_id = current_setting('app.memex_id', true)::uuid
  )
  WITH CHECK (
    nullif(current_setting('app.memex_id', true), '') IS NOT NULL
    AND memex_id = current_setting('app.memex_id', true)::uuid
  );

GRANT SELECT, INSERT, UPDATE, DELETE ON standard_clause_facets TO memex_app;

-- 3. task_facet_ballots — the per-task forced full ballot (dec-5) --------------------
--
-- One row per task. `verdict` is the COMPLETE boolean map keyed on each facet's stable
-- slug (full map, not sparse — so "ruled out" ≠ "never considered"). `none` true =
-- honest no-facet work. Record-absent (no row) = not-yet-classified; record-present =
-- classified. `vocabulary_keys` snapshots the slugs the ballot was cast against, so
-- completeness is judged at cast time (dec-7: additive + immutable-once-referenced
-- means a stored ballot stays complete). Memex-scoped → memex_isolation RLS.
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
