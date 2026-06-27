-- spec-340 t-1 (phase 1, the inert foundation): the facet substrate.
--
-- Two tables only — the PRODUCE side:
--   1. facets                 — the per-owner vocabulary (dec-7). Polymorphic owner.
--   2. standard_clause_facets — clause→facet tags (dec-2/dec-8). Memex-scoped.
--
-- The consume-side ballot tables (task/decision facet ballots) belong to phase 2
-- (spec-423) and are deliberately NOT created here.
--
-- Named UNIQUE / CHECK / index names match the Drizzle schema's
-- unique()/index()/uniqueIndex()/check() names so introspection-by-conname stays in
-- lockstep. Idempotent (IF NOT EXISTS) so the hand-migration runner re-applies cleanly.

-- 1. facets — the per-owner vocabulary (dec-7) ---------------------------------------
--
-- POLYMORPHIC owner: owner_type ∈ {org, memex} + owner_id. An org-owned memex shares
-- its org's vocabulary (owner_type='org', owner_id=org.id, per std-4); a personal
-- memex with no owning org carries its own (owner_type='memex', owner_id=memex.id).
-- owner_id is intentionally NOT a foreign key — it points at one of two tables; the
-- seeding paths enforce referential integrity for the org case. Owner-config posture
-- like org_scaffold_additions: NO memex_id, so NO memex_isolation RLS (a row could
-- never satisfy a memex_id=GUC predicate); access is gated at the service layer.
-- Uniqueness is per-owner (owner_type, owner_id, key), so two owners diverge freely.
-- `key` is the stable slug tags anchor on (never rewritten by a display rename, dec-5);
-- `name` is the renameable display override; `description` is the REQUIRED classifier rubric.
CREATE TABLE IF NOT EXISTS facets (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_type  TEXT NOT NULL,
  owner_id    UUID NOT NULL,
  key         TEXT NOT NULL,
  name        TEXT,
  description TEXT NOT NULL,
  ord         INTEGER NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT facets_owner_key_unique UNIQUE (owner_type, owner_id, key),
  CONSTRAINT facets_owner_type_valid CHECK (owner_type IN ('org', 'memex'))
);

CREATE INDEX IF NOT EXISTS facets_owner_idx ON facets (owner_type, owner_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON facets TO memex_app;

-- 2. standard_clause_facets — clause→facet tags (dec-2/dec-8) ------------------------
--
-- Assigned by the agent-driven classifier (local backfill in phase 1; NOT a
-- hand-maintained join — the distinction the spec-193 guard reconciliation rides, t-7).
-- Memex-scoped: rides the standards corpus. The tri-state the design requires (explicit
-- "governs nothing" distinguishable from "not yet classified") is encoded by the
-- nullable facet_id:
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
