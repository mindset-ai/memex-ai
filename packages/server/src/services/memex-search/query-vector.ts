// Query-vector resolution for the search vector arms (spec-522 t-2, dec-1).
//
// WHAT THIS REPLACED. `provider.embed([query], "query")` used to be called
// independently by each of the three vector arms — sections, decisions, issues —
// at three separate sites in retrieval.ts. Three external network round-trips to
// Cohere / OpenAI for ONE identical query string, on every settled keystroke
// burst, with no cache anywhere. Two costs, and they are different problems:
//
//   * COST AND QUOTA: 3x what is needed, on every search. Pure waste.
//   * TAIL LATENCY: because the three calls were concurrent, the MEAN added
//     latency was roughly one round-trip, but every search waited for the
//     SLOWEST OF THREE independent samples. The p95 of max(3 samples) is
//     materially worse than the p95 of one — which is why search felt erratic
//     rather than uniformly slow. Measured (spec-522 s-2): the full search ran
//     810 ms at p50 but 1153 ms at p90, a spread no single-embed variant showed.
//
// The round-trip itself measured ~130 ms (s-2 experiment 1: three single-embed
// arms over completely different corpora landed within 85 ms of each other; the
// shared constant IS the embed).
//
// TENANCY [per std-35]. A query embedding is a pure function of the query string
// and the model — it carries NO tenant data — so the cache is deliberately shared
// across every Memex, and keying it on `(model, query)` is correct rather than a
// leak. The asymmetry worth stating explicitly, because it looks like an
// oversight and is not: std-35 cl-5 forbids putting query TEXT into telemetry,
// and this holds user-typed query text in process memory. Those are different
// risks — durable, exportable analytics versus a bounded in-process map that dies
// with the instance — and the second is accepted here where the first is not.
//
// ACCEPTED RISK — a timing side channel. A cache hit is measurably faster than a
// miss, so a caller sharing an instance can in principle probe whether a given
// string was recently searched BY ANYONE. It reveals only that some user searched
// some string within the TTL: not who, not in which Memex, not any result. Judged
// acceptable against the ~130 ms saved, and bounded further by the TTL and by the
// cache being per-instance. Recorded so it stays a decision rather than becoming
// a discovery (spec-522 s-6).
//
// NO REDIS, deliberately. This is a bounded process-local Map — the established
// idiom here, precedent spec-458 dec-10 (/api/live serves from a ~30s
// process-local TTL cache "so cost is one indexed query per instance per TTL
// window regardless of visitor count"). A shared cache tier would give a better
// hit rate across Cloud Run instances, but introducing a new running component to
// cache a value this cheap to recompute is disproportionate (spec-522 dec-1).

import type { EmbeddingProvider } from "../embedding-provider.js";

/** A resolved query embedding plus the model that produced it. The model travels
 *  WITH the vector because it is already the correctness boundary downstream:
 *  every vector arm filters `embedding_model = <model>`, so a vector and a model
 *  name that disagree would silently query the wrong population. Keeping them in
 *  one value makes that mismatch unrepresentable. */
export interface ResolvedQueryVector {
  readonly vector: number[];
  readonly model: string;
}

/** Entry cap. Bounds memory: each entry is a 1536-float vector (~12 KB as JS
 *  numbers) plus the query string, so 500 entries is single-digit MB — small
 *  against a Cloud Run instance, and far more distinct queries than one instance
 *  sees inside a TTL window in practice. */
const DEFAULT_MAX_ENTRIES = 500;

/** TTL. This bounds MEMORY, not staleness — the embedding of a given string under
 *  a given model is immutable, so a cached vector can never go stale or wrong.
 *  Without a TTL a long-lived instance would accumulate every distinct query it
 *  ever saw; with one, an unused entry ages out. */
const DEFAULT_TTL_MS = 10 * 60 * 1000;

/**
 * Ceiling on how long a search will wait for the embedding provider before
 * giving up and serving handle + FTS hits alone (spec-522 t-5, dec-3).
 *
 * GENEROUS BY DESIGN, and the value matters. Without a timeout a hanging embed
 * hangs its arm and, through the orchestrator's `Promise.all`, the entire search
 * — an outage at Cohere/OpenAI became an outage for ⌘K. But a timeout set too
 * tight is worse than none: results would silently vary with provider latency,
 * the same query would return different hits on different days, and ac-3 result
 * parity would become untestable.
 *
 * 3000 ms is chosen against the measured distribution rather than by intuition
 * (spec-522 s-2): the round-trip is ~130 ms at p50, single-embed variants ran
 * 470–511 ms at p90, and the worst single sample observed across ~100 live
 * requests was 752 ms end-to-end INCLUDING the route floor and the SQL. So this
 * sits roughly 20x the median and ~6x the worst thing actually seen — far enough
 * out that tripping it means the provider is genuinely down, not merely slow.
 *
 * Env-overridable so it can be tuned on int without a code change, matching the
 * MEMEX_SEARCH_MAX_VECTOR_DISTANCE precedent in retrieval.ts.
 */
const DEFAULT_EMBED_TIMEOUT_MS = 3_000;

export function resolveEmbedTimeoutMs(explicit?: number): number {
  if (typeof explicit === "number" && Number.isFinite(explicit) && explicit > 0) {
    return explicit;
  }
  const env = process.env.MEMEX_SEARCH_EMBED_TIMEOUT_MS;
  if (env) {
    const parsed = Number(env);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return DEFAULT_EMBED_TIMEOUT_MS;
}

interface CacheEntry {
  vector: number[];
  expiresAt: number;
}

/**
 * Bounded, TTL'd, LRU-ish cache of query embeddings.
 *
 * Exported as a CLASS rather than hidden behind a module-level singleton with a
 * reset hatch, so tests can construct an instance with a tiny cap and TTL and
 * assert the eviction behaviour honestly. Production uses the module singleton
 * below; nothing production-side should ever construct its own.
 */
export class QueryVectorCache {
  private readonly entries = new Map<string, CacheEntry>();
  private readonly maxEntries: number;
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(opts: { maxEntries?: number; ttlMs?: number; now?: () => number } = {}) {
    this.maxEntries = opts.maxEntries ?? DEFAULT_MAX_ENTRIES;
    this.ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
    this.now = opts.now ?? Date.now;
  }

  /** `\u0000` (NUL) as the separator, not `:` — a NUL cannot appear in a Postgres text
   *  query, so no user-typed query can forge a key belonging to another model. */
  private static key(model: string, query: string): string {
    return `${model}\u0000${query}`;
  }

  get(model: string, query: string): number[] | undefined {
    const k = QueryVectorCache.key(model, query);
    const hit = this.entries.get(k);
    if (!hit) return undefined;

    if (hit.expiresAt <= this.now()) {
      this.entries.delete(k);
      return undefined;
    }

    // Re-insert to move this key to the end of the Map's insertion order, so the
    // eviction below sheds the LEAST-RECENTLY-USED key rather than the oldest
    // one. A hot repeated query then survives a flood of one-off queries.
    this.entries.delete(k);
    this.entries.set(k, hit);
    return hit.vector;
  }

  set(model: string, query: string, vector: number[]): void {
    const k = QueryVectorCache.key(model, query);
    this.entries.delete(k);
    this.entries.set(k, { vector, expiresAt: this.now() + this.ttlMs });

    // Evict from the front (least-recently-used) until back within the cap. A
    // `while` rather than an `if` so the cache self-heals if the cap is ever
    // lowered at runtime.
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      this.entries.delete(oldest.value);
    }
  }

  get size(): number {
    return this.entries.size;
  }
}

/** The process-local cache every search shares. Per-instance by design: hit rate
 *  falls as Cloud Run scales out, and that is accepted (dec-1). */
const defaultCache = new QueryVectorCache();

/**
 * Await `provider.embed`, but never for longer than `timeoutMs`.
 *
 * The underlying SDK call is NOT cancellable — it keeps running and its socket
 * closes in its own time. What this bounds is how long the SEARCH waits, which is
 * the thing that matters: a hung provider must not hold the request open.
 * `clearTimeout` in the `finally` matters — without it a pending timer keeps the
 * event loop alive after a fast success, which in a test run looks like a suite
 * that will not exit.
 */
async function embedWithTimeout(
  provider: EmbeddingProvider,
  query: string,
  timeoutMs: number,
): Promise<number[] | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expiry = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error(`embedding provider timed out after ${timeoutMs}ms`)),
      timeoutMs,
    );
  });

  try {
    const [vector] = await Promise.race([provider.embed([query], "query"), expiry]);
    return vector;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Resolve the query vector ONCE for a search, from cache when possible.
 *
 * Returns `null` when the embedding cannot be obtained — no provider, the
 * provider threw, or it exceeded the timeout. `null` means "run FTS-only", which
 * is how a slow or unavailable embedding provider degrades search rather than
 * breaking it (ac-4). Callers must treat it as a normal outcome, never an error.
 *
 * ac-4 HAS TWO HALVES AND THEY ARRIVED SEPARATELY. The UNAVAILABLE half already
 * worked before spec-522: each arm wrapped its embed in try/catch, so a throwing
 * provider yielded no rows and handle + FTS hits still rendered. The SLOW half did
 * not: there was no timeout anywhere, so a hanging call hung its arm and, through
 * the orchestrator's `Promise.all`, the whole search. The timeout below is what
 * closes that (dec-3).
 *
 * BLAST RADIUS, changed deliberately (dec-1). Each arm used to wrap its own embed
 * call in try/catch, so a transient provider failure killed ONE arm and the other
 * two still returned rows. With a single shared embed, a failure removes all three
 * vector arms together. That is more consistent — a search should not return
 * section vector hits but no decision vector hits because one of three identical
 * calls happened to fail — but it IS a behaviour change, not a neutral refactor.
 */
export async function resolveQueryVector(
  provider: EmbeddingProvider | null,
  query: string,
  cache: QueryVectorCache = defaultCache,
  timeoutMs: number = resolveEmbedTimeoutMs(),
): Promise<ResolvedQueryVector | null> {
  if (!provider) return null;

  const cached = cache.get(provider.name, query);
  if (cached) return { vector: cached, model: provider.name };

  let vector: number[] | undefined;
  try {
    vector = await embedWithTimeout(provider, query, timeoutMs);
  } catch {
    // Swallowed on purpose — both the provider's own error and our timeout take
    // this path, so slow and unavailable degrade identically. The arms used to
    // swallow provider errors individually; that behaviour moves here intact.
    return null;
  }
  if (!vector) return null;

  cache.set(provider.name, query, vector);
  return { vector, model: provider.name };
}
