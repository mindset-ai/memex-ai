-- Semantic search: model tagging + HNSW index on embedding vectors.
--
-- Purpose: enable natural-language search over ingested code by embedding each
-- symbol at ingest time and querying with pgvector cosine similarity. Query-time
-- recall ≥ lexical FTS for "find code that does X" questions where X is
-- expressed in business language (e.g. "retry logic" surfaces backoff / httpx
-- streaming / try-except-around-sleep patterns that don't contain the string
-- "retry").
--
-- Two changes in this migration:
--   1) model column on embeddings, so we can A/B embedding providers without
--      a data migration. Default 'openai-text-embedding-3-large-1536' (primary;
--      reuses the Mindset OpenAI relationship already used by the RAG CF for
--      text-embedding-3-small; we pick `large` because it's meaningfully better
--      on code). Alternatives: 'cohere-embed-v4-1536', 'voyage-code-3-1536', etc.
--   2) HNSW index on the embedding vector for sub-linear similarity search.
--      Matters at scale; even at our current ~2400 rows across 3 repos the
--      index overhead is negligible and it future-proofs multi-repo growth.

ALTER TABLE "embeddings"
  ADD COLUMN "model" text NOT NULL DEFAULT 'openai-text-embedding-3-large-1536';
--> statement-breakpoint

-- HNSW index. Cosine distance matches how we'll query (normalised vectors,
-- `1 - (embedding <=> query)` gives a similarity score in [0,1]).
-- m=16, ef_construction=64 are pgvector defaults — good quality/latency trade
-- for our size; we can tune if recall@k drops below acceptable in practice.
CREATE INDEX "embeddings_vector_hnsw_idx"
  ON "embeddings" USING hnsw ("embedding" vector_cosine_ops);
--> statement-breakpoint

-- Compound index for model-scoped queries. When we A/B test a new model, the
-- agent can filter `WHERE model = 'cohere-embed-v4-1536'` and expect the
-- planner to intersect efficiently with the HNSW search.
CREATE INDEX "embeddings_repo_model_idx" ON "embeddings" ("repo_id", "model");
