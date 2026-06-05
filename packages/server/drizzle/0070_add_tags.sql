-- spec-136 t-1: scoped tags on Specs (GitLab-style), with a basic tag filter.
--
-- Two tables, mirroring the spec's data model (s-3):
--   * tags          — the per-Memex catalogue of distinct tags. One row per unique
--                     {scope, value} (dec-1: structured tag, NOT a parsed string).
--                     A flat/unscoped tag is stored with scope = NULL.
--   * document_tags — the bridge linking a tag to a Spec (dec-2: a single FK-backed
--                     bridge to `documents`, NOT a polymorphic object_tags table).
--
-- Both carry memex_id (spec-125: tenant key on every row) so the filter and isolation
-- scope by tenant without a join.
--
-- Additive, no backfill — existing Specs start untagged.
--
-- Attribution: develop landed the spec-122 actor/channel contract + activity_log
-- (0060). For the denormalised bridge-table column we follow develop's clearest
-- neighbouring pattern — doc_assignees.assigned_by — a SINGLE `added_by` FK to
-- users(id) ON DELETE SET NULL (removing the actor keeps the link). Cross-actor
-- attribution (human / mcp_agent / system) is recorded on the unified bus → the
-- activity_log subscriber, derived from the ChangeEvent channel, NOT denormalised here.

CREATE TABLE tags (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  memex_id   UUID NOT NULL,
  -- The part before `::` for a scoped tag (`priority` in `priority::high`).
  -- NULL = a flat, multi-valued tag (`bug`, `frontend`).
  scope      TEXT,
  -- The part after `::`, or the whole tag for a flat one. Never NULL.
  value      TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Canonicalises a tag to one row per Memex (dec-1): `priority::high` is a single row
  -- no matter how many Specs carry it. NULLS NOT DISTINCT (PG 15+, we run PG 16) is
  -- essential — without it two flat `bug` tags (scope = NULL) would both be allowed,
  -- because NULL <> NULL in a default unique constraint, defeating canonicalisation.
  CONSTRAINT tags_memex_scope_value_unique UNIQUE NULLS NOT DISTINCT (memex_id, scope, value)
);

CREATE INDEX tags_memex_id_idx ON tags (memex_id);

CREATE TABLE document_tags (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  memex_id    UUID NOT NULL,
  -- The FK is the point of dec-2: deleting a Spec cascade-deletes its tag links, so
  -- there are no dangling rows and no orphan sweep to run.
  document_id UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  tag_id      UUID NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  -- Attribution (matches doc_assignees.assigned_by): who applied the tag. ON DELETE
  -- SET NULL so removing the user keeps the tag link. Actor *kind* (human/mcp/system)
  -- is carried on the bus event → activity_log, not denormalised onto this row.
  added_by    UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- A Spec cannot carry the same tag twice; a repeat assignment is idempotent.
  CONSTRAINT document_tags_document_tag_unique UNIQUE (document_id, tag_id)
);

-- Forward filter ("tags on this Spec") and reverse lookup ("Specs with this tag"),
-- both tenant-scoped so the query never joins just to scope by tenant.
CREATE INDEX document_tags_memex_document_idx ON document_tags (memex_id, document_id);
CREATE INDEX document_tags_memex_tag_idx ON document_tags (memex_id, tag_id);
