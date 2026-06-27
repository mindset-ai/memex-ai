// spec-423 t-3 (dec-3) — the pluggable precision re-ranker. Cohere is the first
// concrete backend; the interface is provider-agnostic. ENABLED by default whenever
// a credential is present; the caller degrades to the keyless density baseline on
// absence, outage, or error/timeout — never blocking the work.
//
// This is the REBUILT artifact: the spike's facet-rerank.ts + the recall@10≈0.88
// gold set could not be located on any spike branch, so the re-ranker is
// re-established here and the dec-4 routing log captures the real-traffic evidence
// to re-establish the lift and build a clean relevance gold set.

// A candidate section to score. dec-1: scoring is at SECTION grain, not isolated
// clause (an isolated clause strips a rule's conditional context). Scores roll up
// to the owning standard (max over its sections).
export interface RerankDoc {
  handle: string;
  text: string;
}

export interface Reranker {
  readonly model: string;
  // Per-handle relevance score (max over that handle's sections). Throws on
  // outage/error so the caller can degrade to the keyless baseline.
  rerank(query: string, docs: RerankDoc[]): Promise<Map<string, number>>;
}

const COHERE_RERANK_URL = "https://api.cohere.com/v2/rerank";
const COHERE_MODEL = "rerank-v3.5";
const DEFAULT_TIMEOUT_MS = 4000;

export class CohereReranker implements Reranker {
  readonly model = `cohere:${COHERE_MODEL}`;
  constructor(
    private readonly apiKey: string,
    private readonly timeoutMs: number = DEFAULT_TIMEOUT_MS,
  ) {}

  async rerank(query: string, docs: RerankDoc[]): Promise<Map<string, number>> {
    const byHandle = new Map<string, number>();
    if (docs.length === 0) return byHandle;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await fetch(COHERE_RERANK_URL, {
        method: "POST",
        headers: { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model: COHERE_MODEL, query, documents: docs.map((d) => d.text), top_n: docs.length }),
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`Cohere rerank failed: ${res.status}`);
      const json = (await res.json()) as { results: Array<{ index: number; relevance_score: number }> };
      // Roll section scores up to the owning standard — max wins (dec-1 section grain).
      for (const r of json.results) {
        const doc = docs[r.index];
        if (!doc) continue;
        const prev = byHandle.get(doc.handle);
        if (prev === undefined || r.relevance_score > prev) byHandle.set(doc.handle, r.relevance_score);
      }
      return byHandle;
    } finally {
      clearTimeout(timer);
    }
  }
}

// The active reranker, or null when no credential is present (keyless baseline).
// Reads COHERE_API_KEY — wired from the `cohere-api-key` Secret Manager secret on
// Cloud Run (present on int; absent on prod until provisioned, and on self-host /
// BYOK / free tier). Absence is a normal degraded state, never an error.
export function getReranker(): Reranker | null {
  const key = process.env.COHERE_API_KEY;
  if (!key) return null;
  return new CohereReranker(key);
}
