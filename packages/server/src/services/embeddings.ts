// Embeddings service: bulk insert at ingest time, semantic similarity at query time.
//
// Write path: the extractor generates one embedding per symbol (name + signature +
// docstring + body preview) and calls createEmbeddings with the batch. Chunked to
// stay under the 65535 bound-parameter cap.
//
// Read path: semanticSearch takes an already-embedded query vector (the caller
// embeds the user's query once; we don't re-embed per call) and returns the
// top-K most-similar chunks in the repo, with their symbol + file context.
//
// The `model` filter lets callers A/B embedding providers: query with
// model='openai-text-embedding-3-large-1536' one week, 'cohere-embed-v4-1536'
// the next, see which recalls better.

import { and, eq, sql } from "drizzle-orm";
import { db, type Db } from "../db/connection.js";
import { embeddings, files, symbols } from "../db/schema.js";
import { bulkInsertChunks } from "./shared/bulk.js";

export interface EmbeddingInsert {
  repoId: string;
  fileId: string | null;
  symbolId: string | null;
  chunkText: string;
  chunkKind: string | null;
  embedding: number[]; // length must match column dim (1536)
  model: string;
}

export async function createEmbeddings(
  rows: EmbeddingInsert[],
  client: Db = db,
): Promise<void> {
  if (rows.length === 0) return;
  await bulkInsertChunks(rows, async (chunk) => {
    await client.insert(embeddings).values(
      chunk.map((r) => ({
        repoId: r.repoId,
        fileId: r.fileId,
        symbolId: r.symbolId,
        chunkText: r.chunkText,
        chunkKind: r.chunkKind,
        embedding: r.embedding,
        model: r.model,
        lastUpdatedAt: new Date(),
      })),
    );
    return [] as never[];
  });
}

export interface SemanticHit {
  symbolId: string | null;
  symbolName: string | null;
  symbolKind: string | null;
  fileId: string;
  filePath: string;
  lineStart: number | null;
  lineEnd: number | null;
  chunkKind: string | null;
  score: number; // cosine similarity in [0,1]; higher is better
  snippet: string;
}

// Cosine similarity between query and chunk, joined back to symbol + file so
// the agent gets file:line context without a second round trip.
// `1 - (embedding <=> query)` yields cosine similarity because pgvector's <=>
// operator returns cosine *distance* (1 - similarity).
export async function semanticSearch(
  repoId: string,
  queryEmbedding: number[],
  opts: { limit?: number; model?: string } = {},
  client: Db = db,
): Promise<SemanticHit[]> {
  const limit = Math.max(1, Math.min(opts.limit ?? 10, 50));
  const model = opts.model ?? null;

  // Parameter-binding the pgvector literal: format as Postgres array-of-floats
  // and cast to vector(1536). Drizzle's sql template takes the typed param
  // directly, but we pass the JSON array text to avoid typing headaches with
  // the custom vector column on the write path vs read path.
  const vectorLiteral = `[${queryEmbedding.join(",")}]`;

  const rows = await client
    .select({
      symbolId: embeddings.symbolId,
      symbolName: symbols.name,
      symbolKind: symbols.kind,
      fileId: files.id,
      filePath: files.path,
      lineStart: symbols.lineStart,
      lineEnd: symbols.lineEnd,
      chunkKind: embeddings.chunkKind,
      chunkText: embeddings.chunkText,
      // 1 - cosine_distance = cosine similarity in [0, 1].
      score: sql<number>`1 - (${embeddings.embedding} <=> ${sql.raw(`'${vectorLiteral}'::vector(1536)`)})`,
    })
    .from(embeddings)
    .innerJoin(files, eq(files.id, embeddings.fileId))
    .leftJoin(symbols, eq(symbols.id, embeddings.symbolId))
    .where(
      model
        ? and(eq(embeddings.repoId, repoId), eq(embeddings.model, model))
        : eq(embeddings.repoId, repoId),
    )
    .orderBy(sql`${embeddings.embedding} <=> ${sql.raw(`'${vectorLiteral}'::vector(1536)`)}`)
    .limit(limit);

  return rows.map((r) => ({
    symbolId: r.symbolId,
    symbolName: r.symbolName,
    symbolKind: r.symbolKind,
    fileId: r.fileId,
    filePath: r.filePath,
    lineStart: r.lineStart,
    lineEnd: r.lineEnd,
    chunkKind: r.chunkKind,
    score: Number(r.score),
    snippet: r.chunkText.slice(0, 400),
  }));
}
