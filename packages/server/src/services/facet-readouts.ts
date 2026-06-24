// spec-340 t-6 — the org-owner readouts, all plain queries over the captured data
// (no developer-facing reporting tool, ac-6). Two of the standards-tab trinity:
//   • COVERAGE — facets work touches with no governing standard (a gap)
//   • POPULARITY — which standards the hot facets route to
// The third pillar, ADHERENCE, is consumed from spec-151's clause-level test
// events and is deliberately NOT re-derived here.
//
// dec-3: the coverage map post-filters the SAME stored ballots the routing union
// (t-5) reads — one source, two aggregators. Routing uses the recall-first union;
// the coverage map applies a discriminating, tunable threshold.

import { eq } from "drizzle-orm";
import { db } from "../db/connection.js";
import { taskFacetBallots } from "../db/schema.js";
import { standardsForFacets } from "./facet-routing.js";

// The coverage-map threshold: a facet counts only if >= N tasks touch it. Read
// from config (tunable), NOT a constant baked into the schema (dec-3). Default 2.
export function coverageThreshold(): number {
  const raw = process.env.MEMEX_FACET_COVERAGE_THRESHOLD;
  const n = raw ? Number.parseInt(raw, 10) : Number.NaN;
  return Number.isInteger(n) && n > 0 ? n : 2;
}

/**
 * Per-facet DEMAND: how many tasks (across the memex) marked the facet true in
 * their ballot. The work-side signal both readouts derive from — read off the
 * stamps, since a supply-side view is structurally blind to gaps (s-2).
 */
export async function facetDemand(memexId: string): Promise<Map<string, number>> {
  const rows = await db
    .select({ verdict: taskFacetBallots.verdict })
    .from(taskFacetBallots)
    .where(eq(taskFacetBallots.memexId, memexId));
  const demand = new Map<string, number>();
  for (const r of rows) {
    for (const [k, v] of Object.entries(r.verdict as Record<string, boolean>)) {
      if (v === true) demand.set(k, (demand.get(k) ?? 0) + 1);
    }
  }
  return demand;
}

export interface CoverageGap {
  facetKey: string;
  demand: number;
}

/**
 * COVERAGE GAPS (ac-6): facets that work touches at or above the threshold with NO
 * governing standard behind them, ranked by how often work hit them (demand desc).
 * Post-filters the same ballots the union reads — discriminating, not recall-first.
 */
export async function coverageGaps(memexId: string, threshold = coverageThreshold()): Promise<CoverageGap[]> {
  const demand = await facetDemand(memexId);
  const gaps: CoverageGap[] = [];
  for (const [facetKey, n] of demand) {
    if (n < threshold) continue;
    const governing = await standardsForFacets(memexId, [facetKey]);
    if (governing.length === 0) gaps.push({ facetKey, demand: n });
  }
  return gaps.sort((a, b) => b.demand - a.demand || a.facetKey.localeCompare(b.facetKey));
}

export interface StandardPopularity {
  handle: string;
  title: string;
  /** Summed demand of the facets this standard governs — how often work hit them. */
  demand: number;
}

/**
 * STANDARD POPULARITY (ac-6): for each standard the hot facets route to, the summed
 * demand of the facets it governs. A standard with hot facets but low surfacing is a
 * findability/description problem, not necessarily a dead rule.
 */
export async function standardPopularity(memexId: string): Promise<StandardPopularity[]> {
  const demand = await facetDemand(memexId);
  const standards = await standardsForFacets(memexId, [...demand.keys()]);
  return standards
    .map((s) => ({
      handle: s.handle,
      title: s.title,
      demand: s.facetKeys.reduce((sum, k) => sum + (demand.get(k) ?? 0), 0),
    }))
    .sort((a, b) => b.demand - a.demand || a.handle.localeCompare(b.handle));
}
