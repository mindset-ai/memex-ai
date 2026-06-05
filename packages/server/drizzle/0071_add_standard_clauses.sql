-- spec-150 t-2: standard clauses become first-class rows (dec-1).
--
-- A standard's body was section prose, and a single section bundles many independent
-- normative clauses (std-17's "Rule" section alone holds five). This table makes each
-- clause an addressable, allocate-once row — a peer of `acs` — so verification, the
-- clause-coverage view (spec-151), and future impact analysis can reason per clause
-- rather than per whole section.
--
-- Why a DEDICATED table and NOT doc_sections rows (dec-1 grounding):
--   The embed + FTS pipelines key on doc_sections — one pgvector row per section
--   (services/memex-embeddings.ts) and a generated `content_tsv` per section. Per-
--   clause rows in doc_sections would be embedded and FTS-indexed independently,
--   changing the search corpus and breaking the transparency contract. Clauses live
--   here instead; doc_sections.content stays the byte-identical projection of the
--   section preamble + its composed clauses (see the derived-projection work, t-3).
--
-- Identity vs order (dec-2):
--   * `seq` is allocate-once per standard — it IS the `cl-N` canonical-ref segment —
--     and is NEVER resequenced. Deleting or inserting a clause leaves every other
--     clause's seq untouched; gaps are tolerated, exactly like `acs`. Because a
--     deleted seq is never reused, a plain UNIQUE(doc_id, seq) is sufficient (no
--     partial index, unlike doc_sections, which resequences its tail on delete).
--   * `position` is the separate, freely-resequencing ordering used ONLY to compose
--     section content and to render clauses within their section.
--
-- memex_id is carried on every row (spec-125 tenant-key convention) so reads scope by
-- tenant without a join. Soft-delete lifecycle mirrors doc_sections / decisions.

CREATE TABLE standard_clauses (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  memex_id        UUID NOT NULL,
  -- The standard this clause belongs to. Cascade so deleting the doc clears clauses.
  doc_id          UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  -- The section this clause renders under. Cascade with the section.
  section_id      UUID NOT NULL REFERENCES doc_sections(id) ON DELETE CASCADE,
  -- Allocate-once per-standard handle → the `cl-N` ref segment. Never resequenced.
  seq             INTEGER NOT NULL,
  -- Ordering within the section (composition + display only). May resequence freely.
  position        INTEGER NOT NULL,
  -- The clause's normative markdown.
  body            TEXT NOT NULL,
  -- Soft-delete lifecycle (spec-107 precedent): flip to 'deleted', capture prior
  -- status in previous_status for lossless restore. Read paths filter status<>'deleted'.
  status          TEXT NOT NULL DEFAULT 'active',
  previous_status TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Allocate-once seq → plain unique is enough. A deleted seq is never reused, so a
  -- soft-deleted row can't collide with a live insert; no resequencing is needed.
  CONSTRAINT standard_clauses_doc_seq_unique UNIQUE (doc_id, seq)
);

CREATE INDEX standard_clauses_doc_id_idx ON standard_clauses (doc_id);
CREATE INDEX standard_clauses_section_id_idx ON standard_clauses (section_id);
CREATE INDEX standard_clauses_memex_id_idx ON standard_clauses (memex_id);

-- The section's non-clause connective prose (dec-1: a section keeps a preamble PLUS
-- ordered clause children). NULL = not decomposed; `content` stays authoritative for
-- every non-standard doc and any standard section not yet decomposed. When clauses
-- exist, `content` is the derived byte-identical projection of (preamble + clauses),
-- so the embed / FTS / export / admin read paths are unchanged.
ALTER TABLE doc_sections ADD COLUMN preamble TEXT;
