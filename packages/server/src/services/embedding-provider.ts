// Embedding provider abstraction. Used both by the extractor at ingest time
// (to embed each symbol chunk) and by the MCP semantic_search handler at
// query time (to embed the user's natural-language query).
//
// Adding a new provider:
//   1. Implement EmbeddingProvider with a stable `name` (goes into
//      embeddings.model so queries can filter by it).
//   2. Register it in resolveEmbeddingProvider().
//   3. Set EMBEDDING_PROVIDER=<name> in the environment.
//
// The `name` string must be stable over time — it's stored per-row and used
// to match query-time embeddings against document-time embeddings. If you
// change what a provider embeds (different model, different dim, different
// input shape), bump the `name` so new rows don't collide with old ones.

import OpenAI from "openai";
import { CohereClient } from "cohere-ai";

export interface EmbeddingProvider {
  readonly name: string;
  readonly dim: number;
  readonly maxBatchSize: number;
  embed(texts: string[], kind: "document" | "query"): Promise<number[][]>;
}

// Cohere embed-v4 at 1536 dim. Matches our pgvector column natively.
// Asymmetric: `input_type` differs for documents (at ingest) vs queries
// (at search). Kept as an A/B alternative to OpenAI. Note: Mindset already
// has a Cohere relationship but uses it for reranking (not embedding);
// adding embed-v4 is a new endpoint on the same account.
class CohereEmbeddingProvider implements EmbeddingProvider {
  readonly name = "cohere-embed-v4-1536";
  readonly dim = 1536;
  readonly maxBatchSize = 96; // Cohere's embed endpoint: up to 96 inputs/call
  private client: CohereClient;

  constructor(apiKey: string) {
    this.client = new CohereClient({ token: apiKey });
  }

  async embed(texts: string[], kind: "document" | "query"): Promise<number[][]> {
    if (texts.length === 0) return [];
    const inputType =
      kind === "document" ? "search_document" : "search_query";
    // `client.v2.embed` (not `client.embed`) is the newer endpoint that
    // supports `outputDimension` for matryoshka-style dim selection.
    const resp = await this.client.v2.embed({
      model: "embed-v4.0",
      texts,
      inputType,
      embeddingTypes: ["float"],
      outputDimension: this.dim,
    });
    // v2 response shape: { embeddings: { float?: number[][], int8?: ... } }.
    // We only requested float, so that's what we read.
    const floats = resp.embeddings.float;
    if (!floats) {
      throw new Error("Cohere v2 embed response missing float embeddings");
    }
    return floats;
  }
}

// OpenAI text-embedding-3-large, matryoshka-truncated to 1536 dim.
// Default provider. Uses the existing Mindset OpenAI relationship (same
// account the RAG CF uses for text-embedding-3-small; we pick `large` here
// because it's measurably better on code while costing only ~6x more per
// token — still negligible absolute dollars for our corpus).
// Rows are tagged with model 'openai-text-embedding-3-large-1536' so the
// A/B query-time `model` filter can pick the right population.
class OpenAIEmbeddingProvider implements EmbeddingProvider {
  readonly name = "openai-text-embedding-3-large-1536";
  readonly dim = 1536;
  readonly maxBatchSize = 96;
  private client: OpenAI;

  constructor(apiKey: string) {
    this.client = new OpenAI({ apiKey });
  }

  async embed(texts: string[], _kind: "document" | "query"): Promise<number[][]> {
    // OpenAI embeddings are symmetric; `kind` is ignored here but accepted
    // for interface parity with the asymmetric Cohere provider.
    if (texts.length === 0) return [];
    const resp = await this.client.embeddings.create({
      model: "text-embedding-3-large",
      input: texts,
      dimensions: this.dim,
    });
    const sorted = [...resp.data].sort((a, b) => a.index - b.index);
    return sorted.map((d) => d.embedding);
  }
}

// Resolution order:
//   1. EMBEDDING_PROVIDER explicitly set → use that (errors if missing key)
//   2. Else: OPENAI_API_KEY present → OpenAI (default, matches existing Mindset stack)
//   3. Else: COHERE_API_KEY present → Cohere (A/B alternative)
//   4. Else: null — caller handles degraded mode
export function resolveEmbeddingProvider(): EmbeddingProvider | null {
  if (process.env.EMBEDDING_DISABLED === "1") return null;

  const explicit = process.env.EMBEDDING_PROVIDER;
  if (explicit) {
    if (explicit === "none") return null;
    if (explicit === "cohere") {
      const key = process.env.COHERE_API_KEY;
      if (!key) return null;
      return new CohereEmbeddingProvider(key);
    }
    if (explicit === "openai") {
      const key = process.env.OPENAI_API_KEY;
      if (!key) return null;
      return new OpenAIEmbeddingProvider(key);
    }
    throw new Error(
      `Unknown EMBEDDING_PROVIDER='${explicit}'. Supported: openai, cohere, none.`,
    );
  }

  // Auto-pick: OpenAI is the stated primary (existing Mindset relationship);
  // fall through to Cohere if no OpenAI key but a Cohere key is present.
  if (process.env.OPENAI_API_KEY) {
    return new OpenAIEmbeddingProvider(process.env.OPENAI_API_KEY);
  }
  if (process.env.COHERE_API_KEY) {
    return new CohereEmbeddingProvider(process.env.COHERE_API_KEY);
  }
  return null;
}
