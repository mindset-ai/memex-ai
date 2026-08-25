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

// ── Memoisation (spec-522 t-3, dec-2) ──────────────────────────────────────
//
// WHY: resolveEmbeddingProvider() is called PER REQUEST at nine sites
// (memex-search, code-search, memex-embeddings, three agent handlers, the
// extractor). Constructing `new OpenAI(...)` / `new CohereClient(...)` on every
// call hands each query a brand-new SDK client with a brand-new HTTP agent, so
// no keep-alive connection and no TLS session is ever reused — every embed pays
// a fresh DNS + TCP + TLS handshake on the hot search path. One long-lived
// client per configuration lets the SDK's connection pool actually pool.
// Providers here are stateless with respect to callers, so sharing is safe.
//
// ⚠ THIS FILE IS A KNOWN std-30 VIOLATION, and the memo does NOT fix that.
// std-30 covers embeddings explicitly — cl-1 ("generative and embeddings
// alike"), cl-2 ("no OpenAI/Cohere embedding client construction … outside the
// wrapper"), cl-3 ("no `embeddings.create` / `provider.embed`, outside the
// wrapper"), and cl-11 names search embeddings in scope by name. This module
// constructs both SDK clients and calls both inference methods directly, and
// writes no telemetry row, so embedding spend is entirely unmetered (cl-4).
//
// It survived because cl-5's "enforced by lint" is only half-built: the guard
// (__regression__/no-direct-anthropic.regression.test.ts) bans `new Anthropic`
// and nothing else, so these call sites pass CI. Do not read the green build as
// compliance.
//
// Memoising makes the violation CHEAPER, not compliant — it is a deliberate
// mitigation, not a fix. Real compliance means routing embeddings through the
// metering wrapper and accepting cl-4's telemetry, which is its own piece of
// work. Recorded as drift on std-30 (c-2) via spec-522 dec-2; do not delete this
// note until that lands.
//
// WHY THE MEMO IS KEYED ON THE ENV TUPLE, NOT A BARE MODULE SINGLETON — please
// do not "simplify" this into `let cached ??= resolve()`:
//   * Resolution is a pure function of four env vars, and those env vars are
//     MUTATED AT RUNTIME BY TESTS. routes/search.integration.test.ts sets
//     EMBEDDING_DISABLED=1 inside vi.hoisted(); agent/decision-related-issues
//     .integration.test.ts leans on env-driven resolution too.
//   * vitest runs with fileParallelism: true and test FILES SHARE A WORKER
//     PROCESS — so module state populated by one file is still there when the
//     next file in that worker imports the same module. A bare singleton would
//     let an earlier file's provider (or its `null`) leak into a later file and
//     fail ORDER-DEPENDENTLY — the classic fixture-isolation trap [per std-37].
//   * Keying on the resolved inputs makes the memo a cache in the strict sense:
//     same inputs → same instance; different inputs → recomputed. No reset call
//     is required for correctness, so nothing can forget to make one.
//
// Deliberately NOT exporting a __resetCacheForTests() hatch: the env-tuple key
// already gives every test a clean slate (vary any of the four vars and you get
// a fresh resolution), and an exported reset is a foot-gun that production code
// can call to throw away the very connection pool this memo exists to keep.
//
// The key embeds the raw API-key strings. They are already in process.env in
// this same process, so this adds no new exposure — and it must be the exact
// value, not a presence flag, so that ROTATING a key rebuilds the client.
interface ProviderMemo {
  readonly key: string;
  readonly provider: EmbeddingProvider | null;
}
let memo: ProviderMemo | null = null;

// JSON (not join) so that "unset" (→ null) and "" stay distinguishable, and so
// a value containing the separator can't forge a different tuple.
function embeddingEnvKey(): string {
  return JSON.stringify([
    process.env.EMBEDDING_DISABLED,
    process.env.EMBEDDING_PROVIDER,
    process.env.OPENAI_API_KEY,
    process.env.COHERE_API_KEY,
  ]);
}

// Resolution order:
//   1. EMBEDDING_PROVIDER explicitly set → use that (errors if missing key)
//   2. Else: OPENAI_API_KEY present → OpenAI (default, matches existing Mindset stack)
//   3. Else: COHERE_API_KEY present → Cohere (A/B alternative)
//   4. Else: null — caller handles degraded mode
//
// Returns the SAME instance for repeated calls while the four embedding env
// vars are unchanged; a change to any of them resolves afresh and replaces the
// memo (see above). Env is read at CALL time, never at import time.
export function resolveEmbeddingProvider(): EmbeddingProvider | null {
  const key = embeddingEnvKey();
  if (memo !== null && memo.key === key) return memo.provider;

  // Note the ordering: resolveFresh() may THROW (unknown EMBEDDING_PROVIDER),
  // and we only write the memo on the success path — so the throw is NOT
  // cached. That is deliberate. A bad EMBEDDING_PROVIDER is a misconfiguration,
  // not a resolved state: every call must keep surfacing it (the pre-memo
  // contract), and correcting the env must recover immediately without anyone
  // having to remember to clear a cache. Caching a rejection would also pin a
  // stale error message after the var changed. Any pre-existing memo for a
  // DIFFERENT key is left intact — reverting the env re-hits it.
  const provider = resolveFresh();
  memo = { key, provider };
  return provider;
}

// The unmemoised resolution — the pre-spec-522 body of resolveEmbeddingProvider,
// unchanged. Register new providers HERE (step 2 of the header recipe); the memo
// above is transparent and needs no edit.
function resolveFresh(): EmbeddingProvider | null {
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
