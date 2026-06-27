// spec-423 t-3 — recall-first facet→standards routing (dec-1) + ranking (dec-2/dec-3).
//
// Candidate generation is a deterministic join over standard_clause_facets MEMBER
// rows (facet_id NOT NULL) — every standard owning >=1 clause tagged to a balloted
// facet, NEVER pruned before the cut (recall-first; missing a governing standard is
// the only real harm). Ranking: a keyless clause-density baseline everywhere (TF
// over the tags, pure arithmetic), with the pluggable precision re-ranker
// (facet-rerank.ts) replacing the score when a credential is present and degrading
// to the baseline on any error. Surfacing: top-K, NO relevance floor, scores shown.

import { and, eq, inArray, isNotNull } from "drizzle-orm";
import { db } from "../db/connection.js";
import { facets, standardClauseFacets, standardClauses, documents, docSections } from "../db/schema.js";
import { getReranker, type Reranker, type RerankDoc } from "./facet-rerank.js";

export const KEYLESS_MODEL = "keyless-density";

export interface RankedStandard {
  handle: string;
  title: string;
  /** Which of the balloted facets this standard governs (via member clauses). */
  facetKeys: string[];
  /** Rank score — keyless density (0..1) or the re-ranker's relevance. */
  score: number;
  /** Within the top-K attention cap (dec-2). */
  surfaced: boolean;
}

export interface RoutingResult {
  /** The top-K, ordered by score, scored, NO floor (dec-2). The payoff readout. */
  surfaced: RankedStandard[];
  /** The FULL candidate set with scores + surfaced flags — for the dec-4 log. */
  all: RankedStandard[];
  k: number;
  /** 'keyless-density' | 'cohere:rerank-v3.5' — what actually scored this call. */
  rankerModel: string;
}

// The attention cap (dec-2). Starts at 10, env-tunable from the dec-4 logs.
export function topK(): number {
  const raw = process.env.MEMEX_FACET_TOPK;
  const n = raw ? Number.parseInt(raw, 10) : Number.NaN;
  return Number.isInteger(n) && n > 0 ? n : 10;
}

interface Candidate {
  handle: string;
  title: string;
  docId: string;
  facetKeys: Set<string>;
  matchingClauses: Set<string>;
}

// Recall-first candidate generation (dec-1) — never pruned.
async function generateCandidates(memexId: string, facetKeys: string[]): Promise<Candidate[]> {
  if (facetKeys.length === 0) return [];
  const rows = await db
    .select({
      handle: documents.handle,
      title: documents.title,
      docId: documents.id,
      key: facets.key,
      clauseId: standardClauses.id,
    })
    .from(standardClauseFacets)
    .innerJoin(facets, eq(standardClauseFacets.facetId, facets.id))
    .innerJoin(standardClauses, eq(standardClauseFacets.clauseId, standardClauses.id))
    .innerJoin(documents, eq(standardClauses.docId, documents.id))
    .where(and(eq(standardClauseFacets.memexId, memexId), inArray(facets.key, facetKeys)));

  const byStd = new Map<string, Candidate>();
  for (const r of rows) {
    const c =
      byStd.get(r.handle) ??
      { handle: r.handle, title: r.title, docId: r.docId, facetKeys: new Set<string>(), matchingClauses: new Set<string>() };
    c.facetKeys.add(r.key);
    c.matchingClauses.add(r.clauseId);
    byStd.set(r.handle, c);
  }
  return [...byStd.values()];
}

// Keyless density (dec-3 baseline): the fraction of a standard's TAGGED clauses that
// match a balloted facet — a focused standard ranks above a catch-all. Pure
// arithmetic, no external dependency; the universal baseline + degrade target.
async function keylessDensity(memexId: string, candidates: Candidate[]): Promise<Map<string, number>> {
  const score = new Map<string, number>();
  if (candidates.length === 0) return score;
  const docIds = candidates.map((c) => c.docId);
  const totals = await db
    .select({ docId: standardClauses.docId, clauseId: standardClauseFacets.clauseId })
    .from(standardClauseFacets)
    .innerJoin(standardClauses, eq(standardClauseFacets.clauseId, standardClauses.id))
    .where(
      and(
        eq(standardClauseFacets.memexId, memexId),
        inArray(standardClauses.docId, docIds),
        isNotNull(standardClauseFacets.facetId),
      ),
    );
  const totalByDoc = new Map<string, Set<string>>();
  for (const r of totals) {
    const s = totalByDoc.get(r.docId) ?? new Set<string>();
    s.add(r.clauseId);
    totalByDoc.set(r.docId, s);
  }
  for (const c of candidates) {
    const total = totalByDoc.get(c.docId)?.size ?? c.matchingClauses.size;
    score.set(c.handle, total > 0 ? c.matchingClauses.size / total : 0);
  }
  return score;
}

// Candidate SECTIONS (dec-1 section grain) for the re-ranker to score.
async function sectionDocs(candidates: Candidate[]): Promise<RerankDoc[]> {
  if (candidates.length === 0) return [];
  const docIds = candidates.map((c) => c.docId);
  const handleByDoc = new Map(candidates.map((c) => [c.docId, c.handle]));
  const secs = await db
    .select({ docId: docSections.docId, content: docSections.content })
    .from(docSections)
    .where(inArray(docSections.docId, docIds));
  const out: RerankDoc[] = [];
  for (const s of secs) {
    const handle = handleByDoc.get(s.docId);
    if (handle) out.push({ handle, text: s.content });
  }
  return out;
}

/**
 * Route a set of balloted facets to the ranked, surfaced governing standards. The
 * reranker is injectable (defaults to the env-configured one) so tests pin behaviour
 * without a credential. Never throws on a ranker failure — degrades to keyless.
 */
export async function routeFacets(
  memexId: string,
  facetKeys: string[],
  queryText: string,
  reranker: Reranker | null = getReranker(),
): Promise<RoutingResult> {
  const k = topK();
  const candidates = await generateCandidates(memexId, facetKeys);
  if (candidates.length === 0) {
    return { surfaced: [], all: [], k, rankerModel: reranker?.model ?? KEYLESS_MODEL };
  }

  // Baseline score for everyone (dec-3).
  const density = await keylessDensity(memexId, candidates);
  let scoreByHandle = density;
  let rankerModel = KEYLESS_MODEL;

  // Enhancement: replace with the re-ranker's scores when present; degrade on any
  // error (dec-3) — the surface is advisory and never blocks the work.
  if (reranker) {
    try {
      const docs = await sectionDocs(candidates);
      const reranked = await reranker.rerank(queryText, docs);
      if (reranked.size > 0) {
        scoreByHandle = reranked;
        rankerModel = reranker.model;
      }
    } catch {
      scoreByHandle = density;
      rankerModel = KEYLESS_MODEL;
    }
  }

  const ranked: RankedStandard[] = candidates.map((c) => ({
    handle: c.handle,
    title: c.title,
    facetKeys: [...c.facetKeys].sort(),
    score: scoreByHandle.get(c.handle) ?? 0,
    surfaced: false,
  }));
  // Order by score desc, tie-break by handle for determinism. NO floor (dec-2): the
  // ONLY cut is the top-K attention cap, so a low-score candidate within K is kept.
  ranked.sort((a, b) => b.score - a.score || a.handle.localeCompare(b.handle));
  const all = ranked.map((r, i) => ({ ...r, surfaced: i < k }));
  return { surfaced: all.filter((r) => r.surfaced), all, k, rankerModel };
}

/**
 * Render the surfaced standards as the payoff readout appended to the create_task /
 * resolve_decision response. Scores are SHOWN so the agent triages weak matches
 * itself (dec-2). Empty when nothing is governed.
 */
export function formatRoutedStandards(result: RoutingResult): string {
  if (result.surfaced.length === 0) return "";
  const lines = ["", `Standards to keep top-of-mind for this work (top ${result.surfaced.length}, ranked — consult before you code):`];
  for (const s of result.surfaced) {
    lines.push(`- ${s.handle} (${s.score.toFixed(2)}) [${s.facetKeys.join(", ")}] — ${s.title}`);
  }
  return lines.join("\n");
}
