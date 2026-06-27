// spec-423 t-5 — the consume-side orchestration the create_task / resolve_decision
// handlers call: store the (already-validated) ballot, route its true facets to the
// governing standards, log the routing decision, and return the payoff readout.
//
// Split from validation deliberately: the handler validates the ballot BEFORE
// creating the row (so a rejected ballot leaves no orphan), then calls this AFTER the
// row exists (the ballot FK needs it). An empty vocabulary short-circuits to "" —
// nothing to ballot, nothing to route.

import { trueFacetsOf, storeTaskBallot, storeDecisionBallot, type BallotInput } from "./facet-ballot.js";
import { routeFacets, formatRoutedStandards } from "./facet-routing.js";
import { logRouting } from "./facet-routing-log.js";
import type { VocabFacet } from "./facet-vocab.js";
import type { RequestCtx } from "./mutate.js";

// Parse the optional `facetBallot` tool arg into a BallotInput. A missing arg becomes
// the empty ballot — which validateBallotForMemex rejects (re-handing the vocabulary)
// whenever a vocabulary exists, and accepts vacuously when it does not.
export function parseBallotArg(arg: unknown): BallotInput {
  const b = arg as { verdict?: Record<string, boolean>; none?: boolean } | undefined;
  return { verdict: b?.verdict ?? {}, none: b?.none === true };
}

export interface StoreRouteArgs {
  memexId: string;
  specDocId: string;
  noun: "task" | "decision";
  rowId: string;
  ownerRef: string;
  queryText: string;
  ballot: BallotInput;
  vocab: VocabFacet[];
  ctx: RequestCtx;
}

/**
 * Store the ballot, route + rank its true facets, log the routing decision, and
 * return the formatted top-K readout (the payoff appended to the tool response).
 * Returns "" when the owner has no facet vocabulary.
 */
export async function storeRouteAndReadout(args: StoreRouteArgs): Promise<string> {
  const { memexId, specDocId, noun, rowId, ownerRef, queryText, ballot, vocab, ctx } = args;
  if (vocab.length === 0) return "";

  if (noun === "task") {
    await storeTaskBallot(memexId, specDocId, rowId, ballot, vocab, ctx);
  } else {
    await storeDecisionBallot(memexId, specDocId, rowId, ballot, vocab, ctx);
  }

  const facetKeys = trueFacetsOf(ballot, vocab);
  const result = await routeFacets(memexId, facetKeys, queryText);
  await logRouting(memexId, ownerRef, noun, queryText, facetKeys, result);
  return formatRoutedStandards(result);
}
