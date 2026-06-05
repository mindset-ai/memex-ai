-- spec-112 t-1: Issues as a first-class primitive.
--
-- An Issue is a bug or todo registered against a Spec AS A WHOLE — it does not
-- anchor to a section/decision/task (unlike doc_comments). It is modelled on the
-- acs / tasks primitives (0061 / 0005): tenancy on memex_id (NOT NULL,
-- denormalised), parentage + per-Spec handle space via doc_id → documents(id)
-- ON DELETE CASCADE (deleting a Spec deletes its Issues — ac-9), and a
-- UNIQUE(doc_id, seq) allocator minting `i-N` handles independent of the
-- ac/task/comment/decision seq spaces on the same Spec (ac-10).
--
-- "No new infrastructure" (s-4): the parentage column uses the GENERIC name
-- `doc_id` — NOT the legacy `brief_id` that acs carries (that name is the
-- spec-105 carve-out and stays untouched). The embedding triplet mirrors
-- doc_sections (0032) and decisions (0052) so Issues ride the SAME RRF
-- FTS+vector search path (ac-13) — no parallel search infra.
--
-- This migration also extends the ac_parent_links.parent_kind CHECK to add
-- 'issue' (ac-19), so an AC spawned to verify an Issue's expected behaviour can
-- be parented to that Issue.
--
-- Idempotent (IF [NOT] EXISTS / DROP+ADD) so the hand-migration runner can
-- re-apply cleanly on any environment that already carries a partial touch.

-- pgvector extension is already enabled by 0023 / 0032 / 0052; IF NOT EXISTS is
-- defensive and idempotent.
CREATE EXTENSION IF NOT EXISTS vector;

-- 1. issues -------------------------------------------------------------------
--
-- Link columns for the converted target (ac-20/ac-21/ac-23/ac-24), both nullable:
--   satisfying_task_id → the Task an issue→task conversion produced. ON DELETE
--     SET NULL: deleting the Task must NOT cascade-delete the Issue — the kick-up
--     path (ac-31) reverts the Issue to 'open' instead.
--   promoted_doc_id    → the child Spec a promotion produced. ON DELETE SET NULL,
--     same reasoning.
-- Named CHECK constraints (issues_type_valid / issues_status_valid /
-- issues_source_valid) so the SQL stays in lockstep with the Drizzle schema's
-- check() names — introspection by conname (and any future ALTER ... DROP
-- CONSTRAINT) relies on these explicit names rather than Postgres auto-names.
CREATE TABLE IF NOT EXISTS issues (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  memex_id           UUID NOT NULL,
  doc_id             UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  seq                INTEGER NOT NULL,
  title              TEXT NOT NULL,
  body               TEXT NOT NULL,
  type               TEXT NOT NULL,
  severity           TEXT,
  status             TEXT NOT NULL DEFAULT 'open',
  source             TEXT NOT NULL DEFAULT 'human',
  satisfying_task_id UUID REFERENCES tasks(id)     ON DELETE SET NULL,
  promoted_doc_id    UUID REFERENCES documents(id) ON DELETE SET NULL,
  created_by_user_id UUID,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT issues_doc_id_seq_unique UNIQUE (doc_id, seq),
  CONSTRAINT issues_type_valid   CHECK (type   IN ('bug', 'todo')),
  CONSTRAINT issues_status_valid CHECK (status IN ('open', 'converted', 'resolved', 'wont_fix')),
  CONSTRAINT issues_source_valid CHECK (source IN ('human', 'agent'))
);

CREATE INDEX IF NOT EXISTS issues_memex_id_idx ON issues (memex_id);
CREATE INDEX IF NOT EXISTS issues_doc_id_idx   ON issues (doc_id);

-- Embedding triplet — kept OUT of the Drizzle schema (same convention as
-- doc_sections / decisions) so the InferSelectModel shape stays clean for
-- fixtures. Populated fire-and-forget by services/memex-embeddings.ts and read
-- via raw SQL in services/memex-search.ts. 1536-dim matches doc_sections (0032)
-- and decisions (0052). embedding_model lets us A/B providers without a data
-- migration.
ALTER TABLE issues
  ADD COLUMN IF NOT EXISTS embedding            vector(1536),
  ADD COLUMN IF NOT EXISTS embedding_model      text,
  ADD COLUMN IF NOT EXISTS embedding_updated_at timestamptz;

-- HNSW cosine index. m=16 / ef_construction=64 are pgvector defaults — same
-- choice as 0032 (doc_sections) / 0052 (decisions). Cosine distance matches how
-- queries are written: `embedding <=> query` is distance, `1 - distance` the
-- similarity score in [0, 1] for normalised vectors.
CREATE INDEX IF NOT EXISTS issues_embedding_hnsw_idx
  ON issues USING hnsw (embedding vector_cosine_ops);

-- Compound index for model-scoped filters when we A/B providers, mirroring
-- doc_sections_embedding_model_idx / decisions_embedding_model_idx.
CREATE INDEX IF NOT EXISTS issues_embedding_model_idx
  ON issues (embedding_model);

-- 2. ac_parent_links.parent_kind += 'issue' (ac-19) ---------------------------
--
-- DROP+ADD so this migration is idempotent. We drop BOTH the Postgres
-- auto-named constraint that 0061 actually created (its inline column CHECK
-- landed as `ac_parent_links_parent_kind_check`) AND the canonical name the
-- Drizzle schema declares (`ac_parent_links_kind_valid`), then re-add under the
-- canonical name so DB and schema converge on one constraint. 'brief' is NOT
-- renamed — it stays the legacy spec-105 carve-out value.
ALTER TABLE ac_parent_links
  DROP CONSTRAINT IF EXISTS ac_parent_links_parent_kind_check;

ALTER TABLE ac_parent_links
  DROP CONSTRAINT IF EXISTS ac_parent_links_kind_valid;

ALTER TABLE ac_parent_links
  ADD CONSTRAINT ac_parent_links_kind_valid
    CHECK (parent_kind IN ('brief', 'decision', 'issue'));
