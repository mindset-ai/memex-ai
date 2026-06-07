// spec-190 t-6 (dec-6): the voice guide's knowledge store + retrieval path.
//
// The guide_content table (migration 0079) is a GLOBAL corpus of product
// documentation — how Memex works, screen by screen and concept by concept. It
// is NOT tenant-scoped (no memex_id): the guide teaches the product's SHAPE,
// identical for every Memex, and never reads tenant CONTENT (dec-4). Rows are
// heading-bounded markdown chunks imported from guide-content/ by t-7's
// db:import-guide-content.
//
// This module owns three things:
//
//   1. upsertGuideChunk (ac-13) — the write primitive the t-7 importer calls per
//      chunk. Idempotent on (source_path, chunk_index): an unchanged content_hash
//      is NEVER re-embedded (returns "reused"); a changed/new chunk is embedded
//      through the EmbeddingProvider abstraction and upserted. resolveEmbeddingProvider()
//      owns provider choice — Cohere embed-v4 @1536 by default, NOT OpenAI
//      (CAVEAT from code-grounding; do not hard-code an OpenAI assumption).
//
//   2. prefetchScreenContent (ac-14) — Layer 1. On route change, fetch the
//      current screen's chunks deterministically by indexed screen_key lookup.
//      NO embedding call, NO vector search occurs in this path. The result is
//      injected into the graph's guideContext before the next turn.
//
//   3. searchGuideContent (ac-15) — Layer 2. On end-of-speech the ack ping plays
//      immediately (the earcon/blip is the client's job, t-8) and THIS runs
//      behind it: embed the finalized utterance and pgvector-cosine-search the
//      WHOLE corpus, with an FTS fallback when embeddings are absent (spec-64
//      posture). It is also the implementation behind the secondary `search_guide`
//      tool (GUIDE_TOOLS in @memex/shared) — but answering never DEPENDS on the
//      agent choosing to search, because the graph runs Layer 2 every turn
//      regardless (t-3 orchestrator wiring).
//
// Raw SQL for the vector / tsvector columns mirrors services/memex-embeddings.ts
// and services/memex-search.ts: the pgvector `<=>` cosine operator, the
// text-encoded '[v1,...]' literal, and the generated content_tsv FTS column are
// awkward to express through the Drizzle query builder, and the surrounding
// embedding code already speaks raw SQL.

import { sql } from "drizzle-orm";
import { db } from "../db/connection.js";
import {
  resolveEmbeddingProvider,
  type EmbeddingProvider,
} from "./embedding-provider.js";

const DEBUG = process.env.DEBUG_AGENT !== "0";
function log(...args: unknown[]): void {
  if (!DEBUG) return;
  // eslint-disable-next-line no-console
  console.log("[guide-content]", ...args);
}

// pgvector text-encoded literal — matches the vector1536 customType encoding and
// the memex-embeddings / memex-search convention.
function pgvectorLiteral(vec: number[]): string {
  return `[${vec.join(",")}]`;
}

// Relevance floor for the Layer-2 vector arm (spec-64 i-1 posture). pgvector's
// `<=>` is cosine distance in [0, 2]; a hit at/beyond this distance is treated
// as "not actually related" and dropped, so a low-signal utterance doesn't drag
// in unrelated nearest neighbours. Overridable per-env (tuned without a redeploy
// on Cloud Run) and per-call. Default matches memex-search's DEFAULT_MAX_VECTOR_DISTANCE.
const DEFAULT_MAX_VECTOR_DISTANCE = 0.65;

function resolveMaxVectorDistance(explicit?: number): number {
  if (typeof explicit === "number" && Number.isFinite(explicit)) return explicit;
  const env = process.env.MEMEX_GUIDE_MAX_VECTOR_DISTANCE;
  if (env) {
    const parsed = Number(env);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return DEFAULT_MAX_VECTOR_DISTANCE;
}

const DEFAULT_SEARCH_LIMIT = 6;

// ── Write path (ac-13) ──────────────────────────────────────────────────────

export interface GuideChunkInput {
  /** Screen the chunk documents, or null for a cross-screen concept chunk. */
  screenKey: string | null;
  /** Source markdown file the chunk came from (the upsert key, with chunkIndex). */
  sourcePath: string;
  /** Stable ordinal of this chunk within its source file. */
  chunkIndex: number;
  /** The heading the chunk was bounded by (display / debug). */
  heading?: string | null;
  /** Hash of `content` — the importer's change detector. */
  contentHash: string;
  /** The chunk's markdown body. */
  content: string;
}

export interface UpsertGuideChunkResult {
  status:
    | "embedded"
    | "reused"
    | "skipped-no-provider"
    | "skipped-empty"
    | "failed";
  reason?: string;
  model?: string;
}

interface ExistingChunkRow {
  id: string;
  content_hash: string;
  has_embedding: boolean;
  embedding_model: string | null;
}

/**
 * Upsert one guide-content chunk, keyed on (source_path, chunk_index). Embeds
 * `content` through the EmbeddingProvider abstraction and writes the vector +
 * model tag (ac-13).
 *
 * Idempotent: if a row already exists with the same content_hash AND it already
 * carries an embedding from the current provider, the chunk is unchanged and is
 * NOT re-embedded — returns "reused" (the t-7 import is therefore safe to run on
 * every deploy without burning embedding tokens on unchanged content). A hash
 * change, a new chunk, or a row that lost its embedding (e.g. imported in
 * degraded mode) triggers a (re)embed.
 *
 * Best-effort on the embedding leg: a provider error still upserts the row
 * (content + hash) without a vector, so FTS can answer; the next import with a
 * working provider backfills the vector.
 */
export async function upsertGuideChunk(
  chunk: GuideChunkInput,
  options: { provider?: EmbeddingProvider | null } = {},
): Promise<UpsertGuideChunkResult> {
  const content = (chunk.content ?? "").trim();
  if (content.length === 0) {
    return { status: "skipped-empty" };
  }

  const provider =
    options.provider !== undefined ? options.provider : resolveEmbeddingProvider();

  const existingRows = (await db.execute(sql`
    SELECT id, content_hash,
           (embedding IS NOT NULL) AS has_embedding,
           embedding_model
    FROM guide_content
    WHERE source_path = ${chunk.sourcePath} AND chunk_index = ${chunk.chunkIndex}
    LIMIT 1
  `)) as unknown as ExistingChunkRow[];
  const existing = existingRows[0] ?? null;

  // Unchanged content that already has a vector from this provider → reuse.
  // (When there's no provider we can't improve on the existing row either way.)
  if (
    existing &&
    existing.content_hash === chunk.contentHash &&
    (!provider ||
      (existing.has_embedding && existing.embedding_model === provider.name))
  ) {
    return { status: "reused", model: existing.embedding_model ?? undefined };
  }

  // Embed (best-effort). Degraded mode (no provider / provider throws) still
  // upserts the row without a vector — FTS covers, next import backfills.
  let vector: number[] | null = null;
  let model: string | null = null;
  if (provider) {
    try {
      const [v] = await provider.embed([content], "document");
      if (v) {
        vector = v;
        model = provider.name;
      }
    } catch (err) {
      log(
        `embed failed for ${chunk.sourcePath}#${chunk.chunkIndex}: ${
          err instanceof Error ? err.message : String(err)
        } — upserting without vector`,
      );
    }
  }

  const embeddingExpr = vector ? sql`${pgvectorLiteral(vector)}::vector` : sql`NULL`;

  await db.execute(sql`
    INSERT INTO guide_content
      (screen_key, source_path, chunk_index, heading, content_hash, content, embedding, embedding_model, updated_at)
    VALUES
      (${chunk.screenKey}, ${chunk.sourcePath}, ${chunk.chunkIndex}, ${chunk.heading ?? null},
       ${chunk.contentHash}, ${content}, ${embeddingExpr}, ${model}, now())
    ON CONFLICT (source_path, chunk_index) DO UPDATE SET
      screen_key      = EXCLUDED.screen_key,
      heading         = EXCLUDED.heading,
      content_hash    = EXCLUDED.content_hash,
      content         = EXCLUDED.content,
      embedding       = EXCLUDED.embedding,
      embedding_model = EXCLUDED.embedding_model,
      updated_at      = now()
  `);

  if (!provider) return { status: "skipped-no-provider" };
  if (!vector) return { status: "failed", reason: "provider-empty" };
  return { status: "embedded", model: provider.name };
}

/**
 * Prune rows whose source file is no longer present in the import set (ac-18,
 * called by the t-7 importer after a full pass). Returns the number deleted.
 * Lives here next to the write primitive so the table's mutations are in one place.
 */
export async function pruneGuideContent(keepSourcePaths: string[]): Promise<number> {
  if (keepSourcePaths.length === 0) {
    const deleted = (await db.execute(
      sql`DELETE FROM guide_content RETURNING 1`,
    )) as unknown as unknown[];
    return deleted.length;
  }
  const deleted = (await db.execute(sql`
    DELETE FROM guide_content
    WHERE source_path NOT IN (${sql.join(
      keepSourcePaths.map((p) => sql`${p}`),
      sql`, `,
    )})
    RETURNING 1
  `)) as unknown as unknown[];
  return deleted.length;
}

// ── Layer 1: route-change screen pre-fetch (ac-14) ──────────────────────────

interface ContentRow {
  content: string;
}

/**
 * Layer 1 (ac-14): fetch the current screen's guide chunks by a DETERMINISTIC
 * screen_key lookup. NO embedding call and NO vector search happen here — it's a
 * plain indexed equality scan, cheap enough to run on every route change and
 * inject into the graph's guideContext before the next turn. Concept chunks
 * (screen_key NULL) are intentionally excluded — they are search-only (Layer 2).
 */
export async function prefetchScreenContent(
  screenKey: string | null | undefined,
): Promise<string[]> {
  if (!screenKey) return [];
  const rows = (await db.execute(sql`
    SELECT content
    FROM guide_content
    WHERE screen_key = ${screenKey}
    ORDER BY source_path, chunk_index
  `)) as unknown as ContentRow[];
  return rows.map((r) => r.content);
}

// ── Layer 2: per-turn vector search with FTS fallback (ac-15) ────────────────

export type GuideRetrievalMethod = "vector" | "fts";

export interface GuideSearchHit {
  content: string;
  sourcePath: string;
  screenKey: string | null;
  heading: string | null;
  method: GuideRetrievalMethod;
  /** Cosine distance for vector hits; absent for FTS hits. */
  distance?: number;
}

interface VectorHitRow {
  content: string;
  source_path: string;
  screen_key: string | null;
  heading: string | null;
  distance: number;
}

interface FtsHitRow {
  content: string;
  source_path: string;
  screen_key: string | null;
  heading: string | null;
}

/**
 * Layer 2 (ac-15): retrieve the chunks most relevant to a finalized utterance,
 * over the WHOLE corpus. Embeds the utterance and runs a pgvector cosine search
 * bounded by the relevance floor; falls back to Postgres FTS when embeddings are
 * absent — no provider configured, the provider throws, or the corpus has no
 * vectors (e.g. imported in degraded mode). The graph runs this every turn, so a
 * spoken question is answered from retrieved content without the agent having to
 * call the secondary `search_guide` tool.
 */
export async function searchGuideContent(
  query: string,
  options: {
    provider?: EmbeddingProvider | null;
    limit?: number;
    maxVectorDistance?: number;
  } = {},
): Promise<GuideSearchHit[]> {
  const trimmed = (query ?? "").trim();
  if (trimmed.length === 0) return [];

  const limit = options.limit ?? DEFAULT_SEARCH_LIMIT;
  const provider =
    options.provider !== undefined ? options.provider : resolveEmbeddingProvider();

  // Vector arm — only when a provider is configured.
  if (provider) {
    try {
      const [queryVec] = await provider.embed([trimmed], "query");
      if (queryVec) {
        const literal = pgvectorLiteral(queryVec);
        const maxDistance = resolveMaxVectorDistance(options.maxVectorDistance);
        const rows = (await db.execute(sql`
          SELECT content, source_path, screen_key, heading,
                 (embedding <=> ${literal}::vector) AS distance
          FROM guide_content
          WHERE embedding IS NOT NULL
            AND embedding_model = ${provider.name}
            AND (embedding <=> ${literal}::vector) < ${maxDistance}
          ORDER BY embedding <=> ${literal}::vector
          LIMIT ${limit}
        `)) as unknown as VectorHitRow[];
        if (rows.length > 0) {
          return rows.map((r) => ({
            content: r.content,
            sourcePath: r.source_path,
            screenKey: r.screen_key,
            heading: r.heading,
            method: "vector" as const,
            distance: Number(r.distance),
          }));
        }
        // Zero vector hits → fall through to FTS. Covers the "embeddings absent"
        // case where rows exist but were imported without a provider (so they
        // carry no vector), and the floored-out low-signal case.
      }
    } catch (err) {
      log(
        `vector search failed (${
          err instanceof Error ? err.message : String(err)
        }) — falling back to FTS`,
      );
    }
  }

  // FTS fallback (spec-64 posture): lexical match over the generated tsvector.
  const ftsRows = (await db.execute(sql`
    SELECT content, source_path, screen_key, heading,
           ts_rank(content_tsv, plainto_tsquery('english', ${trimmed})) AS rank
    FROM guide_content
    WHERE content_tsv @@ plainto_tsquery('english', ${trimmed})
    ORDER BY rank DESC
    LIMIT ${limit}
  `)) as unknown as FtsHitRow[];
  return ftsRows.map((r) => ({
    content: r.content,
    sourcePath: r.source_path,
    screenKey: r.screen_key,
    heading: r.heading,
    method: "fts" as const,
  }));
}
