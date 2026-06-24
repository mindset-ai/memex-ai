// spec-340 t-4 — the per-task forced full ballot (dec-5), cast at task creation.
//
// D5 resolution: the per-task ballot lives on the task and is captured at
// create_task (NOT at the spec-transition gate, which is grain-mismatched). This
// is the build-start PREDICTIVE pass (dec-4): advisory — a task can be created
// without a ballot (ac-18). But a ballot that IS submitted must be a complete,
// non-contradictory full ballot; the two invalid shapes are rejected back to the
// agent with the vocabulary re-handed (ac-22). The verify gate (t-7) is the
// load-bearing confrontation.

import { and, eq, inArray } from "drizzle-orm";
import { db } from "../db/connection.js";
import { taskFacetBallots, standardClauseFacets, standardClauses, documents, facets } from "../db/schema.js";
import { ValidationError } from "../types/errors.js";
import { resolveActorColumns } from "./actor.js";
import type { RequestCtx } from "./mutate.js";
import { vocabForMemex, type VocabFacet } from "./facet-classifier.js";

export interface BallotInput {
  /** Complete boolean map keyed on each facet's stable slug. */
  verdict: Record<string, boolean>;
  /** Explicit "this work governs no facet" (honest no-facet work). */
  none: boolean;
}

export type BallotCheck =
  | { ok: true }
  | { ok: false; reason: "empty" | "contradiction" | "incomplete"; message: string };

function reHand(vocab: VocabFacet[], lead: string): string {
  const slugs = vocab.map((f) => f.key).join(", ");
  return (
    `${lead} Re-submit a COMPLETE ballot: an explicit true/false verdict for EACH facet ` +
    `[${slugs}], or none:true for legitimate no-facet work (with every facet false).`
  );
}

/**
 * Validate a ballot against the org's vocabulary (dec-5). Rejects the EMPTY
 * verdict (nothing adjudicated, not even none) and the CONTRADICTION (none
 * alongside a real facet); also rejects an INCOMPLETE map (a facet left
 * un-adjudicated) — exhaustiveness is the whole point of the forced ballot.
 */
export function validateBallot(input: BallotInput, vocab: VocabFacet[]): BallotCheck {
  const verdict = input.verdict ?? {};
  const none = input.none === true;
  const slugs = vocab.map((f) => f.key);
  const hasTrue = slugs.some((s) => verdict[s] === true);

  if (none && hasTrue) {
    return {
      ok: false,
      reason: "contradiction",
      message: reHand(vocab, "Contradiction: none:true cannot accompany any facet marked true."),
    };
  }
  if (!none) {
    if (Object.keys(verdict).length === 0) {
      return { ok: false, reason: "empty", message: reHand(vocab, "Empty ballot: nothing was adjudicated, not even none.") };
    }
    const missing = slugs.filter((s) => typeof verdict[s] !== "boolean");
    if (missing.length > 0) {
      return {
        ok: false,
        reason: "incomplete",
        message: reHand(vocab, `Incomplete ballot: ${missing.length} facet(s) not adjudicated (${missing.join(", ")}).`),
      };
    }
    if (!hasTrue) {
      return {
        ok: false,
        reason: "empty",
        message: reHand(vocab, "Empty verdict: every facet is false but none:true was not set — set none:true to declare no-facet work."),
      };
    }
  }
  return { ok: true };
}

/**
 * Load the org vocab and validate a ballot against it; throw a re-handing
 * ValidationError on an invalid ballot (ac-22). Returns the vocab so the caller
 * can store without re-loading. Call this BEFORE creating the task, so a rejected
 * ballot never leaves an orphan task behind.
 */
export async function validateBallotForMemex(memexId: string, input: BallotInput): Promise<VocabFacet[]> {
  const vocab = await vocabForMemex(memexId);
  const check = validateBallot(input, vocab);
  if (!check.ok) throw new ValidationError(check.message);
  return vocab;
}

/**
 * Store a (pre-validated) task ballot. Stores the COMPLETE boolean map keyed on
 * slug (normalising none → all-false) plus the vocabulary snapshot at cast time
 * (dec-7), upserting so a re-cast updates in place (one ballot per task).
 */
export async function storeTaskBallot(
  memexId: string,
  taskId: string,
  input: BallotInput,
  vocab: VocabFacet[],
  ctx: RequestCtx = {},
): Promise<void> {
  const slugs = vocab.map((f) => f.key);
  const verdict: Record<string, boolean> = {};
  for (const s of slugs) verdict[s] = input.none ? false : input.verdict[s] === true;
  const actor = await resolveActorColumns(ctx);

  await db
    .insert(taskFacetBallots)
    .values({ memexId, taskId, verdict, none: input.none === true, vocabularyKeys: slugs, ...actor })
    .onConflictDoUpdate({
      target: taskFacetBallots.taskId,
      set: { verdict, none: input.none === true, vocabularyKeys: slugs, updatedAt: new Date() },
    });
}

/** Validate + store in one step (for non-handler callers and tests). */
export async function castTaskBallot(
  memexId: string,
  taskId: string,
  input: BallotInput,
  ctx: RequestCtx = {},
): Promise<void> {
  const vocab = await validateBallotForMemex(memexId, input);
  await storeTaskBallot(memexId, taskId, input, vocab, ctx);
}

/** The TRUE facet keys of a ballot, computed without a DB read. */
export function trueFacetsOf(input: BallotInput, vocab: VocabFacet[]): string[] {
  if (input.none) return [];
  return vocab.map((f) => f.key).filter((k) => input.verdict[k] === true);
}

/** The task's TRUE facet keys, from its stored ballot ([] if none / no ballot). */
export async function ballotTrueFacets(taskId: string): Promise<string[]> {
  const [row] = await db.select().from(taskFacetBallots).where(eq(taskFacetBallots.taskId, taskId));
  if (!row) return [];
  return Object.entries(row.verdict as Record<string, boolean>)
    .filter(([, v]) => v === true)
    .map(([k]) => k);
}

export interface GoverningClause {
  facetKey: string;
  standardHandle: string;
  clauseBody: string;
}

/**
 * The clauses governing a set of facet keys — the front-load priming for
 * create_task (dec-6). Clause-grain (the standard-grain routing is t-5). Excludes
 * none-markers via the inner join on facet_id.
 */
export async function clausesGoverningFacets(memexId: string, facetKeys: string[]): Promise<GoverningClause[]> {
  if (facetKeys.length === 0) return [];
  const rows = await db
    .select({ facetKey: facets.key, handle: documents.handle, body: standardClauses.body })
    .from(standardClauseFacets)
    .innerJoin(facets, eq(standardClauseFacets.facetId, facets.id))
    .innerJoin(standardClauses, eq(standardClauseFacets.clauseId, standardClauses.id))
    .innerJoin(documents, eq(standardClauses.docId, documents.id))
    .where(and(eq(standardClauseFacets.memexId, memexId), inArray(facets.key, facetKeys)));
  return rows.map((r) => ({ facetKey: r.facetKey, standardHandle: r.handle, clauseBody: r.body }));
}

/** Render the front-load primer appended to the create_task response. */
export function formatFrontLoad(clauses: GoverningClause[]): string {
  if (clauses.length === 0) return "";
  const byStd = new Map<string, GoverningClause[]>();
  for (const c of clauses) {
    const list = byStd.get(c.standardHandle) ?? [];
    list.push(c);
    byStd.set(c.standardHandle, list);
  }
  const lines = ["", "Standards in play for this task (consult before you code):"];
  for (const [handle, cs] of byStd) {
    const facetsHit = [...new Set(cs.map((c) => c.facetKey))].sort().join(", ");
    lines.push(`- ${handle} [${facetsHit}]`);
  }
  return lines.join("\n");
}
