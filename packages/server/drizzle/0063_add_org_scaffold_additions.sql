-- b-68 t-3: per-Org scaffold guidance additions.
--
-- Persists `source: 'org'` GuidanceBlock rows for the unified Scaffold model
-- (`@memex/shared/scaffold-model`). There is deliberately no `source` column —
-- the table IS the discriminator: every row produced by this table is rendered
-- with `source: 'org'` at the service-read mapping layer. This is how dec-3's
-- "append-only at the data layer" guarantee holds: there is literally no
-- schema path to write `source: 'base'` because the column doesn't exist.
-- Base guidance lives in code (`scaffold-data.ts` in @memex/shared), not in
-- this table, so the Org mutation surface cannot reach it.
--
-- `target_*` columns roll up into the `target: { phase?, tool?, transition? }`
-- shape on read. An absent dimension matches every value of that dimension
-- (b-68 dec-1). All three NULL is allowed — that's an org-global block.
--
-- `display_order` is the on-disk column name; `order` is a SQL reserved word.
-- The service-layer GuidanceBlock view maps `display_order` → `order`.

CREATE TABLE org_scaffold_additions (
  id                 UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id             UUID         NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  -- Phase the block attaches to. NULL = matches every phase.
  target_phase       TEXT,
  -- Tool name the block attaches to. NULL = matches every tool.
  target_tool        TEXT,
  -- Forward transition the block attaches to (rubric channel). NULL = not a
  -- transition block. Mutually-exclusive-in-practice with phase/tool but the
  -- schema does not enforce this — the projection functions in
  -- @memex/shared decide which channel a row rides.
  target_transition  TEXT,
  text               TEXT         NOT NULL,
  rationale          TEXT         NOT NULL,
  emphasis           TEXT,
  enabled            BOOLEAN      NOT NULL DEFAULT TRUE,
  -- `order` is a SQL reserved word; the on-disk name is `display_order`.
  -- The service layer maps this back to GuidanceBlock.order at read time.
  display_order      INTEGER      NOT NULL DEFAULT 0,
  author_id          UUID         NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at         TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CONSTRAINT org_scaffold_additions_target_phase_valid
    CHECK (target_phase IS NULL OR target_phase IN ('draft', 'plan', 'build', 'verify', 'done')),
  CONSTRAINT org_scaffold_additions_target_transition_valid
    CHECK (target_transition IS NULL OR target_transition IN ('plan', 'build', 'verify', 'done')),
  CONSTRAINT org_scaffold_additions_emphasis_valid
    CHECK (emphasis IS NULL OR emphasis IN ('do', 'dont'))
);

CREATE INDEX org_scaffold_additions_org_id_idx
  ON org_scaffold_additions (org_id);

CREATE INDEX org_scaffold_additions_org_id_target_idx
  ON org_scaffold_additions (org_id, target_phase, target_tool, target_transition);
