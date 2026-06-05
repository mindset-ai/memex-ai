-- Standards embeddings (t-5 of doc-8 / blueprints-to-standards).
--
-- Adds a per-section pgvector embedding column on doc_sections so the agent
-- can do semantic search over standards via `1 - (embedding <=> query)`. The
-- column is nullable because only docType='standard' sections are embedded —
-- generic spec / strategy / mission sections leave it NULL and pay no extra
-- storage beyond the column header.
--
-- Why doc_sections (and not a satellite table):
--   dec-3 / dec-15 prohibit standard-specific tables; standards reuse the
--   document substrate end-to-end. Adding three nullable columns matches that
--   contract and lets the existing FTS pre-narrow continue to work side-by-side
--   with the new vector path.
--
-- Why 1536 dim:
--   Matches the existing `embeddings` table (codebase intelligence) and the
--   matryoshka-truncated OpenAI text-embedding-3-large output that
--   embedding-provider.ts already produces, so we share the provider
--   abstraction instead of standing up a parallel one. Cohere embed-v4 is the
--   declared A/B alternative and also lands at 1536.
--
-- Why model column:
--   Lets us A/B providers (or upgrade to a newer OpenAI dim later) without a
--   data migration; queries can filter `WHERE embedding_model = $X` to keep
--   query-time and document-time vectors aligned. Mirrors the
--   embeddings.model pattern from 0025_semantic_search.sql.

-- pgvector extension is already enabled by 0023_add_codebase_intelligence.sql;
-- the IF NOT EXISTS guard keeps this migration idempotent regardless.
CREATE EXTENSION IF NOT EXISTS vector;

ALTER TABLE "doc_sections"
  ADD COLUMN "embedding" vector(1536),
  ADD COLUMN "embedding_model" text,
  ADD COLUMN "embedding_updated_at" timestamptz;

-- HNSW cosine index. m=16 / ef_construction=64 are pgvector defaults — same
-- choice as 0025_semantic_search.sql for the embeddings table. Cosine
-- distance matches how queries are written: `1 - (embedding <=> query)` gives
-- a similarity score in [0, 1] for normalised vectors.
CREATE INDEX "doc_sections_embedding_hnsw_idx"
  ON "doc_sections" USING hnsw ("embedding" vector_cosine_ops);

-- Compound index for model-scoped filters when we A/B providers, mirroring
-- embeddings_repo_model_idx.
CREATE INDEX "doc_sections_embedding_model_idx"
  ON "doc_sections" ("embedding_model");
