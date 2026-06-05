// Hybrid code search: semantic similarity (symbol-level) + lexical FTS
// (file-level) merged via Reciprocal Rank Fusion.
//
// Why hybrid
//   * Semantic captures meaning: "retry logic" surfaces backoff / try-except
//     even when the code says nothing like "retry."
//   * Lexical catches exact terms: identifier names, string literals, imports
//     that don't embed well into natural language (`kla_verdict`,
//     `_handle_rag`, etc.)
//   Combined: user asks in whatever shape is natural, gets both views.
//
// Why two granularities are OK
//   Embeddings are symbol-level (find a function); FTS is file-level (find
//   a file that mentions a term). The MCP tool returns both kinds clearly
//   labelled. RRF is rank-based, not score-based, so mixed-granularity
//   items merge cleanly — you don't need the scores to be commensurable.
//
// Tuning knob: the RRF constant `k`. Standard value 60 (from the Cormack
// et al. 2009 paper). Higher k flattens contributions from lower-ranked
// items; lower k lets top-ranked items dominate. 60 is fine until we have
// evidence otherwise.

import { searchFileContent } from "./files.js";
import { semanticSearch, type SemanticHit } from "./embeddings.js";
import { resolveEmbeddingProvider } from "./embedding-provider.js";
import type { Db } from "../db/connection.js";
import { db as defaultDb } from "../db/connection.js";

const RRF_K = 60;

export type HybridHit =
  | {
      source: "semantic";
      symbolId: string | null;
      symbolName: string | null;
      symbolKind: string | null;
      fileId: string;
      filePath: string;
      lineStart: number | null;
      lineEnd: number | null;
      snippet: string;
      semanticScore: number; // cosine similarity in [0,1] — highest across phrases
      lexicalScore: null;
      rrfScore: number; // after cross-ranker multiplier
      matchedRankers: number; // how many rankers (phrases + lexical) surfaced this doc
    }
  | {
      source: "lexical";
      symbolId: null;
      symbolName: null;
      symbolKind: null;
      fileId: string;
      filePath: string;
      lineStart: null;
      lineEnd: null;
      snippet: string;
      semanticScore: null;
      lexicalScore: number; // ts_rank_cd score, unit-less
      rrfScore: number;
      matchedRankers: number;
    }
  | {
      source: "both";
      symbolId: string | null;
      symbolName: string | null;
      symbolKind: string | null;
      fileId: string;
      filePath: string;
      lineStart: number | null;
      lineEnd: number | null;
      snippet: string;
      semanticScore: number;
      lexicalScore: number;
      rrfScore: number;
      matchedRankers: number;
    };

export interface CodeSearchOptions {
  // Accepts either `phrase` (single natural-language description) or `phrases`
  // (multiple phrasings of the same intent — ranked independently and merged).
  // Multiple phrasings fight the vocabulary-gap problem: abstract queries
  // often miss code whose identifiers sit in a different vocabulary neighborhood
  // than the asker's phrasing. Giving 3-5 phrasings widens the candidate pool.
  phrase?: string;
  phrases?: string[];
  keywords?: string[]; // optional specific terms, goes to FTS; if omitted, phrases are joined
  limit?: number; // final merged list length, default 10
  perSourceLimit?: number; // how many to pull from each ranker pre-merge, default 20
  model?: string; // embedding model name to filter by (for A/B tests)
}

export async function codeSearch(
  repoId: string,
  opts: CodeSearchOptions,
  client: Db = defaultDb,
): Promise<{ hits: HybridHit[]; warnings: string[] }> {
  const warnings: string[] = [];
  const perSource = Math.max(1, Math.min(opts.perSourceLimit ?? 20, 50));
  const finalLimit = Math.max(1, Math.min(opts.limit ?? 10, 50));

  // Normalise to a single array of phrases. Either shape is accepted for
  // caller convenience; the tool description encourages `phrases` with
  // 3-5 variants for abstract queries.
  const phrases: string[] = [
    ...(opts.phrase ? [opts.phrase] : []),
    ...(opts.phrases ?? []),
  ].map((p) => p.trim()).filter((p) => p.length > 0);

  if (phrases.length === 0) {
    throw new Error(
      "codeSearch requires at least one of `phrase` or `phrases`.",
    );
  }

  // Lexical side: run FTS using the keywords when supplied (better signal —
  // LLM-curated terms), or joined phrases as a fallback. A 20-word phrase
  // is a weak FTS query (stopword-heavy, AND-semantic under plainto_tsquery).
  // This is why the tool encourages `keywords` for the lexical side.
  const lexicalQuery =
    opts.keywords && opts.keywords.length > 0
      ? opts.keywords.join(" ")
      : phrases.join(" ");

  // Kick lexical off first — doesn't depend on the embedding call.
  const lexicalPromise = searchFileContent(repoId, lexicalQuery, perSource, client);

  // Semantic side: embed ALL phrases in one batch (single API call), then
  // run cosine-similarity search per phrase and collect the per-phrase
  // rankings. Each phrase becomes an independent ranker in the RRF merge.
  const phraseHitsList: SemanticHit[][] = [];
  const provider = resolveEmbeddingProvider();
  if (provider == null) {
    warnings.push(
      "semantic search disabled (no embedding API key on the server); falling back to lexical-only",
    );
  } else {
    try {
      // One batched call covers every phrase.
      const vectors = await provider.embed(phrases, "query");
      if (vectors.length !== phrases.length) {
        throw new Error(
          `embed batch size mismatch: got ${vectors.length} vectors for ${phrases.length} phrases`,
        );
      }
      // Per-phrase semantic searches (sequential; each is a fast pgvector hop
      // and the HNSW index makes this effectively free).
      for (let i = 0; i < phrases.length; i++) {
        const hits = await semanticSearch(
          repoId,
          vectors[i]!,
          { limit: perSource, model: opts.model ?? provider.name },
          client,
        );
        phraseHitsList.push(hits);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      warnings.push(`semantic search failed: ${msg}; using lexical-only`);
    }
  }

  const lexicalHits = await lexicalPromise;

  // Merge via RRF. Every ranker (each phrase's top-K list + lexical)
  // contributes 1 / (k + rank) per document it returns. A document that
  // appears high in multiple phrasings (or in both semantic and lexical)
  // accumulates RRF credit from each and bubbles up — that's the whole
  // point of parallel phrasing: redundancy of retrieval across vocabulary
  // neighborhoods.
  const keyOf = (h: { fileId: string; symbolId?: string | null }) =>
    h.symbolId ? `${h.fileId}::${h.symbolId}` : `file::${h.fileId}`;

  const merged = new Map<string, HybridHit>();

  for (const phraseHits of phraseHitsList) {
    for (let i = 0; i < phraseHits.length; i++) {
      const h = phraseHits[i]!;
      const key = keyOf({ fileId: h.fileId, symbolId: h.symbolId });
      const rrf = 1 / (RRF_K + i + 1);
      const existing = merged.get(key);
      if (existing) {
        // Same document ranked by another phrase (or already seen). Add
        // RRF credit, bump the matched-ranker count (used for the
        // cross-ranker multiplier below), and keep the highest semantic
        // score across phrases.
        const bestSem = Math.max(existing.semanticScore ?? 0, h.score);
        merged.set(key, {
          ...existing,
          semanticScore: bestSem,
          rrfScore: existing.rrfScore + rrf,
          matchedRankers: existing.matchedRankers + 1,
        } as HybridHit);
        continue;
      }
      merged.set(key, {
        source: "semantic",
        symbolId: h.symbolId,
        symbolName: h.symbolName,
        symbolKind: h.symbolKind,
        fileId: h.fileId,
        filePath: h.filePath,
        lineStart: h.lineStart,
        lineEnd: h.lineEnd,
        snippet: h.snippet,
        semanticScore: h.score,
        lexicalScore: null,
        rrfScore: rrf,
        matchedRankers: 1,
      });
    }
  }

  lexicalHits.forEach((f, i) => {
    const key = keyOf({ fileId: f.id });
    const rrf = 1 / (RRF_K + i + 1);
    const existing = merged.get(key);
    // Also try to merge a lexical file-level hit into an existing semantic
    // symbol-level hit for the same file — reward files that score on both
    // rankings even when the symbol-level hit was the one that semantic
    // returned.
    const semanticSameFile = findSemanticInSameFile(merged, f.id);

    if (existing) {
      // Exact key match (unusual — would require a file-level semantic hit).
      merged.set(key, {
        ...existing,
        source: existing.source === "semantic" ? "both" : existing.source,
        lexicalScore: f.rank,
        rrfScore: existing.rrfScore + rrf,
        matchedRankers: existing.matchedRankers + 1,
      } as HybridHit);
    } else if (semanticSameFile && semanticSameFile.hit.source === "semantic") {
      // Semantic has a symbol-level hit in this file; promote it to "both"
      // and add lexical's RRF contribution. We only reach here when the
      // existing hit is pure semantic, so the cast below is sound.
      const sem = semanticSameFile.hit;
      merged.set(semanticSameFile.key, {
        source: "both",
        symbolId: sem.symbolId,
        symbolName: sem.symbolName,
        symbolKind: sem.symbolKind,
        fileId: sem.fileId,
        filePath: sem.filePath,
        lineStart: sem.lineStart,
        lineEnd: sem.lineEnd,
        snippet: sem.snippet,
        semanticScore: sem.semanticScore,
        lexicalScore: f.rank,
        rrfScore: sem.rrfScore + rrf,
        matchedRankers: sem.matchedRankers + 1,
      });
    } else {
      merged.set(key, {
        source: "lexical",
        symbolId: null,
        symbolName: null,
        symbolKind: null,
        fileId: f.id,
        filePath: f.path,
        lineStart: null,
        lineEnd: null,
        snippet: buildFileSnippet(f.content ?? "", lexicalQuery),
        semanticScore: null,
        lexicalScore: f.rank,
        rrfScore: rrf,
        matchedRankers: 1,
      });
    }
  });

  // Cross-ranker agreement multiplier. Pure RRF is additive, which gives
  // a doc appearing in 2 rankers roughly 2× the score of one appearing in 1.
  // We want "appearing across multiple phrasings" to be a stronger signal
  // than that — it's evidence that retrieval found the same concept from
  // different vocabulary neighborhoods. Applying √N as a multiplicative
  // bonus sharpens the preference for cross-ranker hits without swamping
  // the RRF ordering inside a single ranker's results.
  //
  // N=1: ×1.00 (no bonus)   N=2: ×1.41   N=3: ×1.73   N=4: ×2.00
  for (const hit of merged.values()) {
    if (hit.matchedRankers > 1) {
      hit.rrfScore *= Math.sqrt(hit.matchedRankers);
    }
  }

  const sorted = [...merged.values()].sort((a, b) => b.rrfScore - a.rrfScore);
  return { hits: sorted.slice(0, finalLimit), warnings };
}

function findSemanticInSameFile(
  merged: Map<string, HybridHit>,
  fileId: string,
): { key: string; hit: HybridHit } | null {
  for (const [key, hit] of merged) {
    if (hit.fileId === fileId && hit.source === "semantic") {
      return { key, hit };
    }
  }
  return null;
}

// Small helper: slice a ~300-char window around the first keyword hit in
// the file content, so the agent gets context without the full file. If no
// keyword lands, return the file head.
function buildFileSnippet(content: string, query: string): string {
  const tokens = query
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 2);
  let idx = -1;
  for (const t of tokens) {
    const re = new RegExp(t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    const m = re.exec(content);
    if (m && (idx === -1 || m.index < idx)) idx = m.index;
  }
  if (idx === -1) return content.slice(0, 400);
  const start = Math.max(0, idx - 100);
  const end = Math.min(content.length, idx + 300);
  return content.slice(start, end);
}
