// spec-423 t-5 — the consume-side orchestration the create_task / resolve_decision
// handlers call: store the (already-validated) ballot, route its true facets to the
// governing standards, log the routing decision, and return the payoff readout.
//
// Split from validation deliberately: the handler validates the ballot BEFORE
// creating the row (so a rejected ballot leaves no orphan), then calls this AFTER the
// row exists (the ballot FK needs it). An empty vocabulary short-circuits to "" —
// nothing to ballot, nothing to route.

import { trueFacetsOf, storeTaskBallot, storeDecisionBallot, type BallotInput } from "./facet-ballot.js";
import { routeFacets, formatRoutedStandards, type ReadoutOccasion } from "./facet-routing.js";
import { logRouting } from "./facet-routing-log.js";
import { afterCommit } from "./after-commit.js";
import type { VocabFacet } from "./facet-vocab.js";
import type { RequestCtx } from "./mutate.js";

/**
 * Route a set of true facets to the governing standards, log the routing decision
 * (dec-4, with the lifecycle occasion), and return the formatted readout. The shared
 * core of both the create/resolve cast path and the in_progress re-surface (dec-10).
 * Does NOT touch the ballot — the caller owns whether a ballot is stored.
 */
export async function routeAndReadout(args: {
  memexId: string;
  ownerRef: string;
  noun: "task" | "decision";
  queryText: string;
  facetKeys: string[];
  occasion: ReadoutOccasion;
}): Promise<string> {
  const { memexId, ownerRef, noun, queryText, facetKeys, occasion } = args;
  // spec-560 — every caller reaches here AFTER its row has committed, and what this
  // produces is advisory context: a readout that fails costs the agent nothing it
  // needed. Guarded here rather than at each call site so the standalone callers get
  // it too (decisions.ts:501 had no guard at all; tasks.ts:445/498 had hand-rolled
  // ones saying exactly this in a comment). "" is what a vocabulary-less or
  // nothing-surfaced run already returns, so the degrade is invisible by construction.
  const readout = await afterCommit(`${noun} standards readout (${ownerRef})`, async () => {
    const result = await routeFacets(memexId, facetKeys, queryText);
    await logRouting(memexId, ownerRef, noun, queryText, facetKeys, result, occasion);
    return formatRoutedStandards(result, occasion);
  });
  return readout.ok ? readout.value : "";
}

// Parse the optional `facetBallot` tool arg into a BallotInput. A missing arg becomes
// the empty ballot — which validateBallotForMemex rejects (re-handing the vocabulary)
// whenever a vocabulary exists, and accepts vacuously when it does not.
export function parseBallotArg(arg: unknown): BallotInput {
  const b = arg as { verdict?: Record<string, boolean>; none?: boolean } | undefined;
  return { verdict: b?.verdict ?? {}, none: b?.none === true };
}

/**
 * Whether the caller CREATED the row or re-cast a ballot on a row that already had one.
 * Required, never defaulted: `decision_facet_ballots` upserts one row per decision, so
 * a failed re-cast leaves the PREVIOUS ballot standing. Telling an update it was
 * "created", or telling a create its old classification stands, are both lies — and a
 * silent default would produce exactly one of them (std-50, spec-560 dec-3).
 */
export type WriteKind = "create" | "recast";

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
  writeKind: WriteKind;
}

// spec-560 dec-3 — what the caller is told when the ballot store fails after the row
// is committed. Three properties are load-bearing: the outcome is stated FIRST and
// plainly; the retry instruction is explicit and NEGATIVE (an agent that has to infer
// not to retry will sometimes infer wrong); and the repair is named as a call it can
// make, not as a condition to report.
//
// The two shapes are not interchangeable. On a create there is no classification at
// all. On a re-cast the previous ballot is still stored, so the row carries a STALE
// classification — and saying it "could not be recorded" there would be true and
// actively misleading: the agent goes looking for an absent ballot and finds a
// plausible wrong one.
//
// Lives here, beside its engine, for the same reason `formatRoutedStandards` does
// (facet-routing.ts): this is the tool's own result text, not agent guidance. It must
// never migrate into the footer — that channel is labelled "platform guidance, not
// tool output", and write semantics stated there would be a fresh instance of the very
// defect this Spec removes (std-15 §3 "does not count"; spec-219 cl-68).
function ballotLostWarning(noun: "task" | "decision", ownerRef: string, writeKind: WriteKind): string {
  const repair = noun === "task" ? "update_task" : "update_decision";
  const recast = `Re-cast it with \`${repair}({ref: "${ownerRef}", facetBallot: {…}})\`.`;
  return writeKind === "create"
    ? `\n\n⚠️ The facet ballot for this ${noun} could not be recorded (the standards database was briefly unavailable), so no governing standards are shown. The ${noun} itself is created — do not create it again. ${recast}`
    : `\n\n⚠️ The facet ballot could not be updated, so this ${noun} still carries the classification it had before and any standards shown may not match. The write itself is saved — do not repeat it. ${recast}`;
}

/**
 * Store the ballot, route + rank its true facets, log the routing decision, and
 * return the formatted top-K readout (the payoff appended to the tool response).
 * Returns "" when the owner has no facet vocabulary.
 *
 * **Runs strictly after the caller's row has committed** (the ballot's FK needs it), so
 * nothing in here may throw: a failure would report a landed write as failed. The two
 * halves fail differently and are guarded separately — collapsing them into one catch
 * would lose the distinction the caller needs (spec-560 dec-3):
 *
 * - the ballot store loses a real thing (the classification) → succeed, but WARN, and
 *   name the repair call;
 * - routing / the readout loses only advisory context → degrade in silence, matching
 *   the precedents at tasks.ts:445, tasks.ts:498, docs.ts:100 and spec-traffic.ts:151.
 */
export async function storeRouteAndReadout(args: StoreRouteArgs): Promise<string> {
  const { memexId, specDocId, noun, rowId, ownerRef, queryText, ballot, vocab, ctx, writeKind } =
    args;
  if (vocab.length === 0) return "";

  const stored = await afterCommit(`${noun} facet ballot store (${ownerRef})`, () =>
    noun === "task"
      ? storeTaskBallot(memexId, specDocId, rowId, ballot, vocab, ctx)
      : storeDecisionBallot(memexId, specDocId, rowId, ballot, vocab, ctx),
  );
  if (!stored.ok) return ballotLostWarning(noun, ownerRef, writeKind);

  // routeAndReadout is already non-fatal (see its guard) — it degrades to "", which is
  // indistinguishable from "no standards surfaced". That is exactly right: nothing the
  // agent needed was lost, and the operator has the logged error.
  const facetKeys = trueFacetsOf(ballot, vocab);
  return routeAndReadout({ memexId, ownerRef, noun, queryText, facetKeys, occasion: "created" });
}
