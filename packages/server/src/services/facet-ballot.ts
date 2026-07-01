// spec-423 t-2 — the forced facet ballot (dec-5), cast on create_task AND
// resolve_decision. Validation + storage for the consume side.
//
// CRITICAL (dec-9 / spec-340 dec-8): the vocabulary is read via facet-vocab.ts
// (NO-LLM), NEVER facet-classifier.ts — the classifier engine must stay off every
// request/write path (the facet-classifier-no-request-path regression guard).
//
// A ballot is a COMPLETE boolean verdict over the owner's live vocabulary: an
// explicit true/false for EACH facet, or `none:true` for honest no-facet work.
// dec-5 forces it on BOTH nouns (decisions are the more reliably-created hook).
// Invalid ballots are rejected back to the agent with the vocabulary re-handed.
// Writes route through mutate() so the task/decision card refetches its pills
// (dec-7 reverses spec-340's inert-phase bus allowlist).

import { and, eq, inArray } from "drizzle-orm";
import { db } from "../db/connection.js";
import { taskFacetBallots, decisionFacetBallots } from "../db/schema.js";
import { ValidationError } from "../types/errors.js";
import { resolveActorColumns } from "./actor.js";
import { mutate, type RequestCtx } from "./mutate.js";
import { vocabForMemex, type VocabFacet } from "./facet-vocab.js";

export interface BallotInput {
  /** Complete boolean map keyed on each facet's stable slug. */
  verdict: Record<string, boolean>;
  /** Explicit "this work governs no facet" (honest no-facet work). */
  none: boolean;
}

export type BallotReason = "empty" | "contradiction" | "incomplete" | "unknown_key";

export type BallotCheck = { ok: true } | { ok: false; reason: BallotReason; message: string };

function reHand(vocab: VocabFacet[], lead: string): string {
  const slugs = vocab.map((f) => f.key).join(", ");
  return (
    `${lead} Re-submit a COMPLETE ballot: an explicit true/false verdict for EACH facet ` +
    `[${slugs}], or none:true for legitimate no-facet work (with every facet false). ` +
    `Call the \`facets\` tool (verb 'list') to re-read the vocabulary.`
  );
}

/**
 * Validate a ballot against the owner's vocabulary (dec-5). Rejects, in order:
 *   • UNKNOWN_KEY  — a verdict key that is not in the live vocabulary,
 *   • CONTRADICTION — none:true alongside a facet marked true,
 *   • EMPTY        — nothing adjudicated (no none, no verdict),
 *   • INCOMPLETE   — a live facet left un-adjudicated (exhaustiveness is the point),
 *   • EMPTY-verdict — every facet false but none:true not set (set none to be explicit).
 */
export function validateBallot(input: BallotInput, vocab: VocabFacet[]): BallotCheck {
  const verdict = input.verdict ?? {};
  const none = input.none === true;
  const slugs = vocab.map((f) => f.key);
  const slugSet = new Set(slugs);

  // An empty vocabulary is vacuously complete — there is nothing to adjudicate, so
  // no ballot is required (a Memex whose owner has no facet vocabulary yet, including
  // every test fixture). The forced ballot only bites where a vocabulary exists.
  if (slugs.length === 0) return { ok: true };

  // Unknown keys first — a stale/hallucinated slug means the agent is working from
  // the wrong vocabulary, so re-hand before anything else.
  const unknown = Object.keys(verdict).filter((k) => !slugSet.has(k));
  if (unknown.length > 0) {
    return {
      ok: false,
      reason: "unknown_key",
      message: reHand(vocab, `Unknown facet key(s): ${unknown.join(", ")}.`),
    };
  }

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
 * Load the owner vocab (via facet-vocab.ts, resolved through the polymorphic owner)
 * and validate a ballot against it; throw a re-handing ValidationError on an invalid
 * ballot. Returns the vocab so the caller can store without re-loading. Call this
 * BEFORE creating the task / resolving the decision, so a rejected ballot never
 * leaves an orphan row behind.
 */
export async function validateBallotForMemex(memexId: string, input: BallotInput): Promise<VocabFacet[]> {
  const vocab = await vocabForMemex(memexId);
  const check = validateBallot(input, vocab);
  if (!check.ok) throw new ValidationError(check.message);
  return vocab;
}

/** Re-handing message for a ballot that is REQUIRED but ABSENT: leads with why it
 *  failed, hands the full ballot shape + vocabulary (via reHand), and, for a non-in-app
 *  caller, adds the stale-schema reload branch (an MCP client on a cached tool list can
 *  only start sending facetBallot after it reloads). */
function requireLead(
  vocab: VocabFacet[],
  opts: { noun: "task" | "decision"; channel?: "mcp" | "in_app_agent" },
): string {
  // The ballot is forced at the CREATE site for both nouns (create_task / create_decision);
  // resolve_decision only ever VALIDATES a provided ballot, so it never reaches this
  // absent-branch. Name the create tool so the remediation points at the right call.
  const tool = opts.noun === "task" ? "create_task" : "create_decision";
  const verb = "created";
  let msg = reHand(
    vocab,
    `A facet ballot is REQUIRED on every ${opts.noun} in this Memex (it has a facet vocabulary), ` +
      `and none was supplied — the ${opts.noun} was NOT ${verb}.`,
  );
  if (opts.channel !== "in_app_agent") {
    msg +=
      ` If your \`${tool}\` tool exposes no \`facetBallot\` parameter, your MCP client is on a cached ` +
      `tool list — reconnect/reload the Memex MCP server to refresh it, then retry.`;
  }
  return msg;
}

/**
 * Enforce the ballot contract at a create/resolve site (re-tightened from spec-423's
 * optional relaxation): where the Memex has a facet vocabulary the ballot is REQUIRED;
 * an empty-vocabulary Memex (including every bare test fixture) needs none. Throws a
 * re-handing ValidationError on an absent-but-required OR invalid ballot, BEFORE the
 * write, so a rejected ballot never leaves an orphan row. Returns the vocab so the
 * caller can store the routing without re-loading it.
 */
export async function requireBallotForMemex(
  memexId: string,
  input: { provided: boolean; ballot: BallotInput },
  opts: { noun: "task" | "decision"; channel?: "mcp" | "in_app_agent" },
): Promise<VocabFacet[]> {
  const vocab = await vocabForMemex(memexId);
  if (vocab.length === 0) return vocab; // no vocabulary → nothing to adjudicate
  if (!input.provided) throw new ValidationError(requireLead(vocab, opts));
  const check = validateBallot(input.ballot, vocab);
  if (!check.ok) throw new ValidationError(check.message);
  return vocab;
}

/** The TRUE facet keys of a ballot, computed without a DB read. */
export function trueFacetsOf(input: BallotInput, vocab: VocabFacet[]): string[] {
  if (input.none) return [];
  return vocab.map((f) => f.key).filter((k) => input.verdict[k] === true);
}

// Normalise a ballot to the COMPLETE boolean map keyed on slug (none → all-false).
function completeVerdict(input: BallotInput, slugs: string[]): Record<string, boolean> {
  const verdict: Record<string, boolean> = {};
  for (const s of slugs) verdict[s] = input.none ? false : input.verdict[s] === true;
  return verdict;
}

/**
 * Store a (pre-validated) task ballot, upserting so a re-cast updates in place (one
 * ballot per task). Routes through mutate() emitting `task` updated on the owning Spec
 * so the React UI refetches the task's facet pills (dec-7).
 */
export async function storeTaskBallot(
  memexId: string,
  specDocId: string,
  taskId: string,
  input: BallotInput,
  vocab: VocabFacet[],
  ctx: RequestCtx = {},
): Promise<void> {
  const slugs = vocab.map((f) => f.key);
  const verdict = completeVerdict(input, slugs);
  await mutate(
    ctx,
    { memexId, docId: specDocId, entity: "task", action: "updated" },
    async () => {
      const [row] = await db
        .insert(taskFacetBallots)
        .values({ memexId, taskId, verdict, none: input.none === true, vocabularyKeys: slugs, ...(await resolveActorColumns(ctx)) })
        .onConflictDoUpdate({
          target: taskFacetBallots.taskId,
          set: { verdict, none: input.none === true, vocabularyKeys: slugs, updatedAt: new Date() },
        })
        .returning();
      return row;
    },
  );
}

/**
 * Store a (pre-validated) decision ballot. dec-6: this is WORK-SIDE routing data only
 * (like tasks) — never surfaced as binding precedent. Emits `decision` updated.
 */
export async function storeDecisionBallot(
  memexId: string,
  specDocId: string,
  decisionId: string,
  input: BallotInput,
  vocab: VocabFacet[],
  ctx: RequestCtx = {},
): Promise<void> {
  const slugs = vocab.map((f) => f.key);
  const verdict = completeVerdict(input, slugs);
  await mutate(
    ctx,
    { memexId, docId: specDocId, entity: "decision", action: "updated" },
    async () => {
      const [row] = await db
        .insert(decisionFacetBallots)
        .values({ memexId, decisionId, verdict, none: input.none === true, vocabularyKeys: slugs, ...(await resolveActorColumns(ctx)) })
        .onConflictDoUpdate({
          target: decisionFacetBallots.decisionId,
          set: { verdict, none: input.none === true, vocabularyKeys: slugs, updatedAt: new Date() },
        })
        .returning();
      return row;
    },
  );
}

/** Validate + store a task ballot in one step (handlers + tests). Returns true facets. */
export async function castTaskBallot(
  memexId: string,
  specDocId: string,
  taskId: string,
  input: BallotInput,
  ctx: RequestCtx = {},
): Promise<string[]> {
  const vocab = await validateBallotForMemex(memexId, input);
  await storeTaskBallot(memexId, specDocId, taskId, input, vocab, ctx);
  return trueFacetsOf(input, vocab);
}

/** Validate + store a decision ballot in one step (handlers + tests). Returns true facets. */
export async function castDecisionBallot(
  memexId: string,
  specDocId: string,
  decisionId: string,
  input: BallotInput,
  ctx: RequestCtx = {},
): Promise<string[]> {
  const vocab = await validateBallotForMemex(memexId, input);
  await storeDecisionBallot(memexId, specDocId, decisionId, input, vocab, ctx);
  return trueFacetsOf(input, vocab);
}

/** The task's stored TRUE facet keys ([] if none / no ballot). */
export async function taskBallotTrueFacets(taskId: string): Promise<string[]> {
  const [row] = await db.select().from(taskFacetBallots).where(eq(taskFacetBallots.taskId, taskId));
  if (!row) return [];
  return Object.entries(row.verdict as Record<string, boolean>).filter(([, v]) => v === true).map(([k]) => k);
}

/** The decision's stored TRUE facet keys ([] if none / no ballot). */
export async function decisionBallotTrueFacets(decisionId: string): Promise<string[]> {
  const [row] = await db.select().from(decisionFacetBallots).where(eq(decisionFacetBallots.decisionId, decisionId));
  if (!row) return [];
  return Object.entries(row.verdict as Record<string, boolean>).filter(([, v]) => v === true).map(([k]) => k);
}

function trueKeysOf(verdict: Record<string, boolean>): string[] {
  return Object.entries(verdict).filter(([, v]) => v === true).map(([k]) => k).sort();
}

/**
 * Batch: the TRUE facet keys for a set of tasks, keyed by task id (the doc-view
 * projection, t-8). Tasks with no ballot (or an all-false `none` ballot) are absent
 * from the map — the caller defaults to [].
 */
export async function facetKeysByTask(memexId: string, taskIds: string[]): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  if (taskIds.length === 0) return out;
  // Filter by memexId EXPLICITLY (not just RLS): on the read path the app.memex_id GUC
  // may be unset, and the runtime role is RLS-subject — an id-only query would return
  // nothing. Matches the standard_clause_facets query pattern.
  const rows = await db
    .select({ taskId: taskFacetBallots.taskId, verdict: taskFacetBallots.verdict })
    .from(taskFacetBallots)
    .where(and(eq(taskFacetBallots.memexId, memexId), inArray(taskFacetBallots.taskId, taskIds)));
  for (const r of rows) out.set(r.taskId, trueKeysOf(r.verdict as Record<string, boolean>));
  return out;
}

/** Batch: the TRUE facet keys for a set of decisions, keyed by decision id (t-8). */
export async function facetKeysByDecision(memexId: string, decisionIds: string[]): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  if (decisionIds.length === 0) return out;
  const rows = await db
    .select({ decisionId: decisionFacetBallots.decisionId, verdict: decisionFacetBallots.verdict })
    .from(decisionFacetBallots)
    .where(and(eq(decisionFacetBallots.memexId, memexId), inArray(decisionFacetBallots.decisionId, decisionIds)));
  for (const r of rows) out.set(r.decisionId, trueKeysOf(r.verdict as Record<string, boolean>));
  return out;
}
