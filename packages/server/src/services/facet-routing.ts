// spec-340 t-5 — routing: facet → governing standards, via a stored-tag DB join
// (dec-2), plus the spec-level UNION aggregation (dec-3).
//
// This is the deterministic routing path consumed at the verify gate (t-7). It is
// a cheap join over the auto-assigned clause→facet tags — NO per-call embedding or
// semantic query sits here (ac-11). Semantic search (services/memex-search.ts
// `searchMemex`) is RETAINED as a non-exclusive backstop for mistagged/untagged
// clauses (ac-12) — it is intentionally NOT imported here, because routing must
// stay a join, not a search.

import { and, eq, inArray } from "drizzle-orm";
import { db } from "../db/connection.js";
import { facets, standardClauseFacets, standardClauses, documents, tasks, taskFacetBallots } from "../db/schema.js";

export interface GoverningStandard {
  /** The standard's `std-N` handle. */
  handle: string;
  title: string;
  /** Which of the queried facets this standard governs (via its member clauses). */
  facetKeys: string[];
}

/**
 * The standards governing a set of facet keys — a distinct-by-standard rollup of
 * the clause→facet tags. Excludes none-markers via the inner join on facet_id.
 * Deterministic and embedding-free.
 */
export async function standardsForFacets(memexId: string, facetKeys: string[]): Promise<GoverningStandard[]> {
  if (facetKeys.length === 0) return [];
  const rows = await db
    .select({ handle: documents.handle, title: documents.title, key: facets.key })
    .from(standardClauseFacets)
    .innerJoin(facets, eq(standardClauseFacets.facetId, facets.id))
    .innerJoin(standardClauses, eq(standardClauseFacets.clauseId, standardClauses.id))
    .innerJoin(documents, eq(standardClauses.docId, documents.id))
    .where(and(eq(standardClauseFacets.memexId, memexId), inArray(facets.key, facetKeys)));

  const byStandard = new Map<string, GoverningStandard>();
  for (const r of rows) {
    const cur = byStandard.get(r.handle) ?? { handle: r.handle, title: r.title, facetKeys: [] };
    if (!cur.facetKeys.includes(r.key)) cur.facetKeys.push(r.key);
    byStandard.set(r.handle, cur);
  }
  return [...byStandard.values()]
    .map((s) => ({ ...s, facetKeys: s.facetKeys.sort() }))
    .sort((a, b) => a.handle.localeCompare(b.handle));
}

/**
 * The spec-level facet UNION (dec-3, recall-first): a facet counts for the spec if
 * ANY of its tasks' ballots marks it true. Derived from the same stored ballots the
 * coverage map (t-6) post-filters — one source, two aggregators.
 */
export async function specFacetUnion(memexId: string, specDocId: string): Promise<string[]> {
  const rows = await db
    .select({ verdict: taskFacetBallots.verdict })
    .from(taskFacetBallots)
    .innerJoin(tasks, eq(taskFacetBallots.taskId, tasks.id))
    .where(and(eq(tasks.docId, specDocId), eq(taskFacetBallots.memexId, memexId)));

  const union = new Set<string>();
  for (const r of rows) {
    for (const [k, v] of Object.entries(r.verdict as Record<string, boolean>)) {
      if (v === true) union.add(k);
    }
  }
  return [...union].sort();
}

/**
 * The verify-gate consumer (t-7): the standards governing a spec's facet union.
 * Union for routing (recall-first) — missing a governing standard is the only
 * real harm; over-inclusion only costs a little attention.
 */
export async function routeStandardsForSpec(memexId: string, specDocId: string): Promise<GoverningStandard[]> {
  const union = await specFacetUnion(memexId, specDocId);
  return standardsForFacets(memexId, union);
}
