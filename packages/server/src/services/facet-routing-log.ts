// spec-423 t-4 (dec-4) — the routing-decision log writer.
//
// One append-only row per routing call on create_task / resolve_decision: the query
// text, the FULL candidate set with ALL scores + the surfaced-vs-cut split, the
// top-K, the ranker model/version, the owning ref, and a timestamp. The substrate to
// tune K from real traffic and rebuild a clean relevance gold set later.
//
// Deliberately OFF the SSE bus — a plain insert, NOT mutate() (telemetry-log posture,
// std-8 silent-allowed; same category as the mcp-telemetry / activity-log writers). A
// routing decision is not a user-observable mutation; it must never fan out to the UI.

import { db } from "../db/connection.js";
import { facetRoutingLog } from "../db/schema.js";
import type { RoutingResult } from "./facet-routing.js";

export async function logRouting(
  memexId: string,
  ownerRef: string,
  noun: "task" | "decision",
  queryText: string,
  facetKeys: string[],
  result: RoutingResult,
): Promise<void> {
  await db.insert(facetRoutingLog).values({
    memexId,
    ownerRef,
    noun,
    queryText,
    facetKeys,
    // The FULL candidate set — surfaced AND cut — each with its score (dec-2: nothing
    // pruned before logging, so K can be re-tuned offline against real traffic).
    candidates: result.all.map((s) => ({ handle: s.handle, title: s.title, score: s.score, surfaced: s.surfaced })),
    k: result.k,
    rankerModel: result.rankerModel,
  });
}
