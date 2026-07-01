// spec-423 t-3 — recall-first facet→standards routing (dec-1) + ranking (dec-2/dec-3).
//
// Candidate generation is a deterministic join over standard_clause_facets MEMBER
// rows (facet_id NOT NULL) — every standard owning >=1 clause tagged to a balloted
// facet, NEVER pruned before the cut (recall-first; missing a governing standard is
// the only real harm). Ranking: a keyless clause-density baseline everywhere (TF
// over the tags, pure arithmetic), with the pluggable precision re-ranker
// (facet-rerank.ts) replacing the score when a credential is present and degrading
// to the baseline on any error. Surfacing: top-K, NO relevance floor, scores shown.

import { and, eq, inArray, isNotNull, ne } from "drizzle-orm";
import { db } from "../db/connection.js";
import { facets, standardClauseFacets, standardClauses, documents, docSections, memexes, namespaces } from "../db/schema.js";
import { getReranker, type Reranker, type RerankDoc } from "./facet-rerank.js";
import { searchMemex, type MemexSearchHit, type MatchingSection } from "./memex-search.js";

export const KEYLESS_MODEL = "keyless-density";

// The unit we actually send back: the SECTION that contains the matched clause (a clause
// alone is decontextualized; the full standard is bloat — the section is the contextful
// sweet spot). Each carries its genealogy so the agent can dig further cheaply.
export interface ImplicatedSection {
  /** Genealogy: which standard this section belongs to. */
  standardHandle: string;
  standardTitle: string;
  /** The section's own heading (title or capitalized type). */
  sectionTitle: string;
  /** The section's text — the actual rule, with context. */
  content: string;
  /** cl-N refs of the clauses in this section that matched a balloted facet (empty for a
   *  section surfaced only by semantic similarity). */
  clauseRefs: string[];
  /** Canonical ref for get_doc(...) to read the whole standard (dig-further pointer). */
  docRef: string;
}

export interface RankedStandard {
  handle: string;
  title: string;
  /** Which of the balloted facets this standard governs (via member clauses). */
  facetKeys: string[];
  /** Rank score — keyless density (0..1) or the re-ranker's relevance. */
  score: number;
  /** Within the top-K attention cap (dec-2). */
  surfaced: boolean;
  /** The implicated sections (matched section content + genealogy), populated for
   *  SURFACED standards only — this is what the readout inlines instead of a pointer. */
  sections?: ImplicatedSection[];
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

// Second, INDEPENDENT recall arm: standards semantically similar to the work text,
// found via the shared hybrid (FTS+vector) retriever scoped to standards. This catches
// governing standards that facet-overlap MISSES because their clauses were never tagged
// with the balloted facet — the tagging is imperfect, so a second retrieval path lowers
// the miss rate (the only real harm). Semantic-only candidates carry no facetKeys (that
// empty set is a natural provenance signal in the readout). Degrades to nothing on any
// error / empty query — the surface is advisory and never blocks the work.
async function semanticCandidates(
  memexId: string,
  queryText: string,
  limit: number,
): Promise<{
  candidates: Candidate[];
  scoreByHandle: Map<string, number>;
  sectionsByHandle: Map<string, MatchingSection[]>;
}> {
  const q = (queryText ?? "").trim();
  if (q.length === 0) return { candidates: [], scoreByHandle: new Map(), sectionsByHandle: new Map() };
  let hits: MemexSearchHit[] = [];
  try {
    hits = await searchMemex(memexId, q, { kind: "standard", limit });
  } catch {
    return { candidates: [], scoreByHandle: new Map(), sectionsByHandle: new Map() };
  }
  const candidates: Candidate[] = [];
  const scoreByHandle = new Map<string, number>();
  const sectionsByHandle = new Map<string, MatchingSection[]>();
  for (const h of hits) {
    const handle = h.path.split("/").filter(Boolean).pop();
    if (!handle || scoreByHandle.has(handle)) continue;
    candidates.push({
      handle,
      title: h.title,
      docId: h.id,
      facetKeys: new Set<string>(),
      matchingClauses: new Set<string>(),
    });
    scoreByHandle.set(handle, h.score);
    sectionsByHandle.set(handle, h.matchingSections ?? []);
  }
  return { candidates, scoreByHandle, sectionsByHandle };
}

// Union the two recall arms by handle; a standard in BOTH keeps its facet info (the
// facet candidate wins the merge, carrying facetKeys/matchingClauses).
function unionByHandle(facet: Candidate[], semantic: Candidate[]): Candidate[] {
  const byHandle = new Map<string, Candidate>();
  for (const c of facet) byHandle.set(c.handle, c);
  for (const c of semantic) if (!byHandle.has(c.handle)) byHandle.set(c.handle, c);
  return [...byHandle.values()];
}

// Reciprocal-rank fusion of the two arms' scores into the keyless baseline: rank each
// arm independently, sum 1/(K+rank). No score normalisation needed to combine a
// facet-density score with a semantic-relevance score. A candidate present in only one
// arm contributes only that arm's term. K=60 is the conventional RRF constant.
function rrfFuse(
  handles: string[],
  density: Map<string, number>,
  semantic: Map<string, number>,
): Map<string, number> {
  const RRF_K = 60;
  const rankOf = (m: Map<string, number>): Map<string, number> => {
    const ordered = [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    const r = new Map<string, number>();
    ordered.forEach(([h], i) => r.set(h, i + 1));
    return r;
  };
  const dRank = rankOf(density);
  const sRank = rankOf(semantic);
  const out = new Map<string, number>();
  for (const h of handles) {
    let s = 0;
    const dr = dRank.get(h);
    const sr = sRank.get(h);
    if (dr !== undefined) s += 1 / (RRF_K + dr);
    if (sr !== undefined) s += 1 / (RRF_K + sr);
    out.set(h, s);
  }
  return out;
}

// Volume controls tuned against the real mindset-prod corpus (a whole section can run
// ~1.5 KB). A short section is sent whole; a long one is pruned to a WINDOW around each
// matched clause, so the agent gets the governing rule with context, not the section's
// unrelated clauses.
const SECTION_CUTOFF_CHARS = 500;
const CLAUSE_WINDOW_RADIUS = 1;

function capitalize(s: string): string {
  return s.replace(/[_-]/g, " ").replace(/\b\w/g, (m) => m.toUpperCase());
}

// Adaptive section body: whole section when short; otherwise merged windows around the
// matched clauses (with "…" marking elided spans). `clauses` is ordered by position.
function windowedContent(
  clauses: { seq: number; body: string }[],
  matchedSeqs: Set<number>,
  cutoff: number,
  radius: number,
): string {
  const full = clauses.map((c) => c.body).join("\n\n");
  if (full.length <= cutoff || clauses.length === 0) return full;
  const matchedIdx = clauses.map((c, i) => (matchedSeqs.has(c.seq) ? i : -1)).filter((i) => i >= 0);
  if (matchedIdx.length === 0) return `${full.slice(0, cutoff).trimEnd()} …`;
  // Merge [idx-radius, idx+radius] windows into contiguous ranges.
  const ranges: Array<[number, number]> = [];
  for (const idx of matchedIdx) {
    const lo = Math.max(0, idx - radius);
    const hi = Math.min(clauses.length - 1, idx + radius);
    const last = ranges[ranges.length - 1];
    if (last && lo <= last[1] + 1) last[1] = Math.max(last[1], hi);
    else ranges.push([lo, hi]);
  }
  const parts: string[] = [];
  if (ranges[0][0] > 0) parts.push("…");
  ranges.forEach(([lo, hi], ri) => {
    parts.push(clauses.slice(lo, hi + 1).map((c) => c.body).join("\n\n"));
    const gapAfter = ri < ranges.length - 1 ? ranges[ri + 1][0] > hi + 1 : hi < clauses.length - 1;
    if (gapAfter) parts.push("…");
  });
  return parts.join("\n\n");
}

// Build the implicated SECTIONS for the surfaced standards: the section that contains a
// matched clause (facet arm) or the semantically-matched section (semantic arm), each
// with its genealogy (owning standard + matched clause refs + a get_doc ref). A long
// section is pruned to windows around its matched clauses.
async function buildImplicatedSections(
  memexId: string,
  surfaced: Candidate[],
  semanticSectionsByHandle: Map<string, MatchingSection[]>,
): Promise<Map<string, ImplicatedSection[]>> {
  const out = new Map<string, ImplicatedSection[]>();
  if (surfaced.length === 0) return out;

  const [slug] = await db
    .select({ ns: namespaces.slug, mx: memexes.slug })
    .from(memexes)
    .innerJoin(namespaces, eq(memexes.namespaceId, namespaces.id))
    .where(eq(memexes.id, memexId))
    .limit(1);
  const refBase = slug ? `${slug.ns}/${slug.mx}/standards` : "standards";

  const clauseIds = surfaced.flatMap((c) => [...c.matchingClauses]);
  if (clauseIds.length > 0) {
    // 1. Matched clauses → their sections + which clause seqs matched.
    const matched = await db
      .select({
        handle: documents.handle,
        title: documents.title,
        sectionId: docSections.id,
        sectionType: docSections.sectionType,
        sectionTitle: docSections.title,
        clauseSeq: standardClauses.seq,
      })
      .from(standardClauses)
      .innerJoin(docSections, eq(standardClauses.sectionId, docSections.id))
      .innerJoin(documents, eq(standardClauses.docId, documents.id))
      .where(inArray(standardClauses.id, clauseIds));

    interface SecAcc {
      handle: string;
      title: string;
      sectionTitle: string;
      matchedSeqs: Set<number>;
      clauseRefs: Set<string>;
    }
    const secs = new Map<string, SecAcc>(); // sectionId → accumulator
    for (const r of matched) {
      const acc =
        secs.get(r.sectionId) ??
        {
          handle: r.handle,
          title: r.title,
          sectionTitle: r.sectionTitle ?? capitalize(r.sectionType),
          matchedSeqs: new Set<number>(),
          clauseRefs: new Set<string>(),
        };
      acc.matchedSeqs.add(r.clauseSeq);
      acc.clauseRefs.add(`${refBase}/${r.handle}/clauses/cl-${r.clauseSeq}`);
      secs.set(r.sectionId, acc);
    }

    // 2. ALL clauses in those sections (ordered) so a long section can be windowed
    //    around its matched clauses instead of dumped whole.
    const allClauses = await db
      .select({
        sectionId: standardClauses.sectionId,
        seq: standardClauses.seq,
        body: standardClauses.body,
      })
      .from(standardClauses)
      .where(and(inArray(standardClauses.sectionId, [...secs.keys()]), ne(standardClauses.status, "deleted")))
      .orderBy(standardClauses.position);
    const clausesBySection = new Map<string, { seq: number; body: string }[]>();
    for (const c of allClauses) {
      const list = clausesBySection.get(c.sectionId) ?? [];
      list.push({ seq: c.seq, body: c.body });
      clausesBySection.set(c.sectionId, list);
    }

    for (const [sectionId, acc] of secs) {
      const clauses = clausesBySection.get(sectionId) ?? [];
      const list = out.get(acc.handle) ?? [];
      list.push({
        standardHandle: acc.handle,
        standardTitle: acc.title,
        sectionTitle: acc.sectionTitle,
        content: windowedContent(clauses, acc.matchedSeqs, SECTION_CUTOFF_CHARS, CLAUSE_WINDOW_RADIUS),
        clauseRefs: [...acc.clauseRefs].sort(),
        docRef: `${refBase}/${acc.handle}`,
      });
      out.set(acc.handle, list);
    }
  }

  // Semantic-only arm: no clause structure, so a long section is head-truncated.
  for (const c of surfaced) {
    if (out.has(c.handle)) continue;
    const secList = semanticSectionsByHandle.get(c.handle) ?? [];
    if (secList.length === 0) continue;
    out.set(
      c.handle,
      secList.map((s) => ({
        standardHandle: c.handle,
        standardTitle: c.title,
        sectionTitle: s.title ?? capitalize(s.sectionType),
        content:
          s.content.length <= SECTION_CUTOFF_CHARS
            ? s.content
            : `${s.content.slice(0, SECTION_CUTOFF_CHARS).trimEnd()} …`,
        clauseRefs: [],
        docRef: `${refBase}/${c.handle}`,
      })),
    );
  }
  return out;
}

/**
 * Route balloted facets + the work text to the ranked, surfaced governing standards.
 * Candidate set is the UNION of two independent recall arms (dec-1, recall-first):
 * facet-overlap (deliberate tags) and semantic similarity of the work text (catches
 * mis-/under-tagged standards). The keyless baseline RRF-fuses the two arms; the
 * pluggable re-ranker replaces it with query-text relevance over the whole union when a
 * credential is present. Never throws on a ranker/retrieval failure — degrades keyless.
 */
export async function routeFacets(
  memexId: string,
  facetKeys: string[],
  queryText: string,
  reranker: Reranker | null = getReranker(),
): Promise<RoutingResult> {
  const k = topK();
  const facetCands = await generateCandidates(memexId, facetKeys);
  const {
    candidates: semCands,
    scoreByHandle: semScore,
    sectionsByHandle: semSections,
  } = await semanticCandidates(memexId, queryText, k);
  const candidates = unionByHandle(facetCands, semCands);
  if (candidates.length === 0) {
    return { surfaced: [], all: [], k, rankerModel: reranker?.model ?? KEYLESS_MODEL };
  }

  // Baseline: RRF of the facet-density arm and the semantic arm (dec-3).
  const density = await keylessDensity(memexId, facetCands);
  let scoreByHandle = rrfFuse(candidates.map((c) => c.handle), density, semScore);
  let rankerModel = KEYLESS_MODEL;

  // Enhancement: replace with the re-ranker's query-text relevance over the whole union
  // when present; degrade to the RRF baseline on any error (advisory, never blocks).
  if (reranker) {
    try {
      const docs = await sectionDocs(candidates);
      const reranked = await reranker.rerank(queryText, docs);
      if (reranked.size > 0) {
        scoreByHandle = reranked;
        rankerModel = reranker.model;
      }
    } catch {
      // keep the RRF baseline already computed above.
    }
  }

  // Normalize scores to 0..1 (top = 1.0) so the agent-facing readout stays interpretable
  // regardless of which ranker produced them (RRF baseline values are tiny; reranker
  // values live on their own scale). Monotonic, so it never changes the ordering.
  const raw = candidates.map((c) => scoreByHandle.get(c.handle) ?? 0);
  const maxScore = raw.length ? Math.max(...raw) : 0;
  const ranked: RankedStandard[] = candidates.map((c) => ({
    handle: c.handle,
    title: c.title,
    facetKeys: [...c.facetKeys].sort(),
    score: maxScore > 0 ? (scoreByHandle.get(c.handle) ?? 0) / maxScore : 0,
    surfaced: false,
  }));
  // Order by score desc, tie-break by handle for determinism. NO floor (dec-2): the
  // ONLY cut is the top-K attention cap, so a low-score candidate within K is kept.
  ranked.sort((a, b) => b.score - a.score || a.handle.localeCompare(b.handle));
  const all = ranked.map((r, i) => ({ ...r, surfaced: i < k }));
  const surfaced = all.filter((r) => r.surfaced);

  // Attach the implicated SECTIONS (matched section content + full genealogy) to the
  // surfaced standards — the readout inlines these instead of a bare pointer.
  const candidateByHandle = new Map(candidates.map((c) => [c.handle, c]));
  const surfacedCandidates = surfaced
    .map((s) => candidateByHandle.get(s.handle))
    .filter((c): c is Candidate => c !== undefined);
  const sectionsByHandle = await buildImplicatedSections(memexId, surfacedCandidates, semSections);
  for (const s of surfaced) s.sections = sectionsByHandle.get(s.handle) ?? [];

  return { surfaced, all, k, rankerModel };
}

// The lifecycle moment a readout is surfaced at (dec-10). Drives both the heading
// wording (execution-framed at in_progress so it doesn't read as a duplicate of the
// creation footer) and the dec-4 routing-log occasion.
export type ReadoutOccasion = "created" | "in_progress";

// The readout inlines the implicated SECTIONS (not pointers, not whole standards), each
// stamped with its exact standard + clause refs so the agent can follow AND cite them
// precisely. Two bounds keep it footer-sized: only the top-N surfaced standards inline
// their sections (the rest get a get_doc pointer), and a hard char budget pre-checked
// before each block so a rogue section can never overshoot. Section length itself is
// already bounded upstream by the clause-window pruning.
const MAX_READOUT_CHARS = 3500;
const MAX_INLINE_STANDARDS = 5;

function indentBlock(text: string): string {
  return text
    .trim()
    .split("\n")
    .map((l) => `    ${l}`)
    .join("\n");
}

/**
 * Render the surfaced standards as the payoff readout appended to the create_decision /
 * create_task / resolve_decision response (occasion 'created') or the update_task →
 * in_progress response (occasion 'in_progress', dec-10). Inlines the implicated section
 * text with full genealogy (exact standard + clause refs + a get_doc ref for depth), so
 * the standard actually gets read instead of just named. Empty when nothing is governed.
 */
export function formatRoutedStandards(result: RoutingResult, occasion: ReadoutOccasion = "created"): string {
  if (result.surfaced.length === 0) return "";
  const n = result.surfaced.length;
  const heading =
    occasion === "in_progress"
      ? `You're starting this task now — ${n} standard${n === 1 ? "" : "s"} govern it. The implicated sections are inlined below, each marked with its exact standard + clause refs. Follow them, and cite them by ref:`
      : `${n} standard${n === 1 ? "" : "s"} govern this work. The implicated sections are inlined below, each marked with its exact standard + clause refs so you can follow and cite them precisely:`;
  const lines = ["", heading];
  let used = heading.length;
  result.surfaced.forEach((s, i) => {
    const facetTag = s.facetKeys.length ? `; facets: ${s.facetKeys.join(", ")}` : "";
    const header = `\n▸ ${s.handle} — "${s.title}" (relevance ${s.score.toFixed(2)}${facetTag})`;
    const sections = s.sections ?? [];
    const docRef = sections[0]?.docRef ?? `…/standards/${s.handle}`;
    // Beyond the inline cap, nothing to inline, or budget spent → a get_doc pointer.
    if (i >= MAX_INLINE_STANDARDS || sections.length === 0 || used >= MAX_READOUT_CHARS) {
      const line = `${header}\n    read it: get_doc ${docRef}`;
      lines.push(line);
      used += line.length;
      return;
    }
    lines.push(header);
    used += header.length;
    for (const sec of sections) {
      const marker = sec.clauseRefs.length
        ? `governing clause${sec.clauseRefs.length === 1 ? "" : "s"}: ${sec.clauseRefs.join(", ")}`
        : `matched section (semantic)`;
      const block = `    § ${sec.sectionTitle} — ${marker}\n${indentBlock(sec.content)}\n    full standard: get_doc ${sec.docRef}`;
      // Pre-check so a block can never push past the budget (no overshoot).
      if (used + block.length > MAX_READOUT_CHARS) {
        const line = `    (more sections in get_doc ${docRef})`;
        lines.push(line);
        used += line.length;
        break;
      }
      lines.push(block);
      used += block.length;
    }
  });
  return lines.join("\n");
}
