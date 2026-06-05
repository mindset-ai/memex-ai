-- Decisions embeddings (b-34 T-1).
--
-- Adds a per-decision pgvector embedding column on `decisions` so the agent
-- can semantically search across resolved/open decisions via the same
-- `1 - (embedding <=> query)` cosine pattern used for doc_sections (0032).
--
-- Why three columns and not a satellite table:
--   Mirrors the doc_sections embedding pattern from 0032. A decision's
--   embedded text is a concatenation of `title + context + resolution`
--   (whatever's present), produced by services/memex-embeddings.ts as
--   fire-and-forget on every write to `decisions`. Three nullable columns
--   match the contract and keep the existing decisions writes unchanged
--   for fixtures that don't care about search.
--
-- Why nullable:
--   New decisions get embedded asynchronously; tests / fixtures that bypass
--   the embedding hook leave them NULL and pay no extra storage. The
--   backfill script (b-34 T-7) catches up legacy rows.
--
-- Why 1536 dim:
--   Same as doc_sections.embedding (0032) and the embeddings table (0025),
--   matching the matryoshka-truncated OpenAI text-embedding-3-large output
--   from embedding-provider.ts. Cohere embed-v4 is the A/B alternative and
--   also lands at 1536. One provider abstraction across the whole project.
--
-- Why model column:
--   Lets us A/B providers without a data migration; queries filter
--   `WHERE embedding_model = $X` to keep query-time and document-time
--   vectors aligned. Mirrors doc_sections.embedding_model and
--   embeddings.model.

-- pgvector extension is already enabled by 0023 / 0032; IF NOT EXISTS is
-- defensive and idempotent.
CREATE EXTENSION IF NOT EXISTS vector;

ALTER TABLE "decisions"
  ADD COLUMN "embedding" vector(1536),
  ADD COLUMN "embedding_model" text,
  ADD COLUMN "embedding_updated_at" timestamptz;

-- HNSW cosine index. m=16 / ef_construction=64 are pgvector defaults — same
-- choice as 0032 for doc_sections. Cosine distance matches how queries are
-- written: `embedding <=> query` returns distance; `1 - distance` is the
-- similarity score in [0, 1] for normalised vectors.
CREATE INDEX "decisions_embedding_hnsw_idx"
  ON "decisions" USING hnsw ("embedding" vector_cosine_ops);

-- Compound index for model-scoped filters when we A/B providers, mirroring
-- doc_sections_embedding_model_idx and embeddings_repo_model_idx.
CREATE INDEX "decisions_embedding_model_idx"
  ON "decisions" ("embedding_model");
