-- spec-190 t-6 (dec-6): the voice guide's knowledge store.
--
-- A single GLOBAL corpus of product documentation — how Memex works, screen by
-- screen and concept by concept. NOT tenant-scoped: the guide teaches the
-- product's SHAPE, identical for every Memex, and never reads tenant CONTENT
-- (dec-4). So there is deliberately no memex_id column; the table is one shared
-- corpus that every session's retrieval reads.
--
-- Rows are heading-bounded markdown chunks imported from guide-content/ by the
-- t-7 `db:import-guide-content` script:
--   * screens/<screen-key>.md  → rows carry screen_key (Layer-1 pre-fetch target)
--   * concepts/*.md            → cross-screen topics, screen_key NULL (search-only)
--
-- Retrieval is two-layer (services/guide-content.ts):
--   Layer 1 (ac-14): route-change pre-fetch — a deterministic screen_key lookup,
--     NO embedding call, NO vector search. The guide_content_screen_key_idx
--     btree index serves it.
--   Layer 2 (ac-15): per-turn vector search over the WHOLE corpus via the HNSW
--     cosine index, with the GIN tsvector index as the FTS fallback when
--     embeddings are absent (spec-64 posture).
--
-- Column conventions mirror the existing embedding-bearing tables exactly:
--   * embedding vector(1536) — matches embedding-provider.ts (OpenAI-large @1536
--     and Cohere embed-v4 @1536 both land here). Written via the EmbeddingProvider
--     abstraction (ac-13); resolveEmbeddingProvider() picks the provider.
--   * embedding_model — provider.name tag, so query-time vectors filter to the
--     same population (the embeddings.model / doc_sections.embedding_model pattern
--     from 0025 / 0032).
--   * content_tsv — generated tsvector (the files.content_tsv pattern from
--     0023_add_codebase_intelligence), GIN-indexed for the FTS fallback.
--
-- Upsert key (the t-7 importer): (source_path, chunk_index). The importer
-- compares the stored content_hash and only re-chunks/re-embeds a chunk whose
-- hash changed, and prunes rows whose source file no longer exists — so the
-- import is idempotent and safe to run on every deploy.
--
-- Revert: drizzle/reverts/0079_add_guide_content.revert.sql drops the table.

-- pgvector is already enabled (0023 / 0032); the guard keeps this idempotent.
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE "guide_content" (
  "id"             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- NULL for cross-screen concept chunks (concepts/*.md). Set for screens/*.md.
  "screen_key"     text,
  "source_path"    text NOT NULL,
  "chunk_index"    integer NOT NULL DEFAULT 0,
  -- The heading the chunk was bounded by (display / debug only).
  "heading"        text,
  "content_hash"   text NOT NULL,
  "content"        text NOT NULL,
  "embedding"      vector(1536),
  "embedding_model" text,
  -- Generated FTS vector. Written automatically by Postgres on insert/update.
  "content_tsv"    tsvector GENERATED ALWAYS AS (to_tsvector('english'::regconfig, COALESCE("content", ''::text))) STORED,
  "created_at"     timestamptz NOT NULL DEFAULT now(),
  "updated_at"     timestamptz NOT NULL DEFAULT now()
);

-- Importer upsert key — one row per (file, chunk).
CREATE UNIQUE INDEX "guide_content_source_path_chunk_idx"
  ON "guide_content" ("source_path", "chunk_index");

-- Layer-1 pre-fetch: deterministic screen_key lookup (no vectors).
CREATE INDEX "guide_content_screen_key_idx"
  ON "guide_content" ("screen_key");

-- Layer-2 FTS fallback.
CREATE INDEX "guide_content_content_tsv_idx"
  ON "guide_content" USING gin ("content_tsv");

-- Layer-2 vector search. HNSW cosine — same m=16 / ef_construction=64 defaults
-- and vector_cosine_ops choice as 0025 / 0032; queries read `1 - (embedding <=> q)`.
CREATE INDEX "guide_content_embedding_hnsw_idx"
  ON "guide_content" USING hnsw ("embedding" vector_cosine_ops);

-- Model-scoped filter parity (mirrors embeddings_repo_model_idx / doc_sections_embedding_model_idx).
CREATE INDEX "guide_content_embedding_model_idx"
  ON "guide_content" ("embedding_model");
