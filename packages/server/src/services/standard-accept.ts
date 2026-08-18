// spec-530 t-4 (dec-4) — `accept_standard_change`: the transactional apply verb.
//
// Accepting a proposal used to be a sequence the AGENT performed. dec-4 made it one
// server operation, for three reasons the code below is shaped by:
//
//   1. ATOMICITY. dec-1 made a proposal a SET of operations, so "two agent calls"
//      would have been "N+1 agent calls" — an interruption leaving a Standard half
//      rewritten with its proposal still open, indistinguishable to the next reader
//      from one not yet applied (ac-10).
//   2. ONE ENFORCEMENT POINT. dec-3's staleness guard and std-8's emit contract are
//      each enforced here, once, instead of being re-derived by every caller.
//   3. CORRECTNESS STOPS LIVING IN THE PROMPT. This Spec exists because a prompt
//      instructed `update_section` on a Standard — a call that has thrown since
//      spec-161 — and nothing noticed for months, because nothing executes prose as a
//      contract. A verb the server owns is testable; a sequence the agent is told to
//      perform is not.
//
// The verb takes the proposal's comment ref and NOTHING else (ac-11): no bodies, no
// targets, no override. The proposal already carries what will be applied, so there is
// no argument through which a caller could apply something other than what a human
// reviewed.

import { and, eq, ne } from "drizzle-orm";
import { db } from "../db/connection.js";
import { docComments, docSections, standardClauses } from "../db/schema.js";
import type { Doc, DocComment, DocSection, StandardClause } from "../db/schema.js";
import { NotFoundError, ValidationError } from "../types/errors.js";
import { mutate, type ChangeKey, type Mutated, type RequestCtx } from "./mutate.js";
import { resolveActorColumns } from "./actor.js";
import {
  insertClauseTx,
  regenerateSectionContentTx,
  softDeleteClauseTx,
  updateClauseBodyTx,
} from "./clauses.js";
import {
  loadOwnedStandard,
  parseProposedChangeBody,
  type ClauseOperation,
} from "./standards.js";

export interface AcceptStandardChangeResult {
  /** The standard whose rule text changed. */
  standard: Doc;
  /** The section the proposal targeted. */
  section: DocSection;
  /** The now-resolved plan_revision comment. */
  comment: DocComment;
  /** How many clause operations were applied. */
  applied: number;
}

/** One operation paired with the live clause row it resolved to. */
type ResolvedOp = { op: ClauseOperation; clause: StandardClause };

/** The `cl-N` handle for a clause row — the identifier every refusal names, so a
 *  reviewer can act on the message without further investigation [per std-10]. */
function handleOf(clause: StandardClause): string {
  return `cl-${clause.seq}`;
}

/**
 * Apply an open `plan_revision` proposal and resolve it, in one transaction.
 *
 * Every read and every check happens BEFORE the transaction writes anything: a
 * mismatch refuses the whole set rather than the offending operation, because a set is
 * one reviewed intent and partial application is what ac-10 forbids.
 */
export async function acceptStandardChange(
  memexId: string,
  commentId: string,
  ctx: RequestCtx = {},
): Promise<Mutated<AcceptStandardChangeResult>> {
  // ── The proposal itself ──
  const comment = await db.query.docComments.findFirst({
    where: and(eq(docComments.id, commentId), eq(docComments.memexId, memexId)),
  });
  // std-7: a comment in another memex is indistinguishable from one that does not
  // exist. Not found, never "not yours".
  if (!comment) throw new NotFoundError(`Proposal ${commentId} not found`);

  if (comment.commentType !== "plan_revision") {
    throw new ValidationError(
      `That comment is a ${comment.commentType}, not a proposal. Only a plan_revision carries clause operations to apply.`,
    );
  }
  if (comment.resolvedAt) {
    throw new ValidationError(
      "That proposal is already resolved — nothing to apply. Re-propose against the current rule if the change is still wanted.",
    );
  }
  if (!comment.sectionId) {
    throw new ValidationError("That proposal is not anchored to a section, so it has no target.");
  }

  const parsed = parseProposedChangeBody(comment.content);
  if (!parsed) {
    throw new ValidationError(
      "That proposal's body carries no readable operations — it cannot be applied. Re-propose it.",
    );
  }
  // t-9's degrade-never-crash contract, seen from the accept side: a pre-cutover
  // whole-section body still READS, but nothing clause-grained can apply it. Refuse
  // with the reason rather than half-applying something (spec-530 dec-2 / t-11 convert
  // the stragglers).
  if (parsed.kind === "legacy") {
    throw new ValidationError(
      "That proposal predates the clause grain — it replaces a whole section, which cannot be applied clause by clause. Restate it as clause operations and re-propose (spec-530 t-11).",
    );
  }
  const operations = parsed.operations;

  // ── The target section + standard ──
  const section = await db.query.docSections.findFirst({
    where: eq(docSections.id, comment.sectionId),
  });
  if (!section) throw new NotFoundError(`Section ${comment.sectionId} not found`);
  const standard = await loadOwnedStandard(memexId, section.docId);

  // ── Resolve every target, memex- AND doc-scoped ──
  // A `cl-N` handle is per-STANDARD (seq is allocated MAX+1 per doc), so the lookup is
  // scoped to this standard's docId. Scoping by memex alone would let a handle collide
  // across two standards in the same memex and apply to the wrong rule.
  const resolved: ResolvedOp[] = [];
  for (const op of operations) {
    const handle = op.op === "add" ? op.anchor : op.clause;
    const seq = Number.parseInt(handle.replace(/^cl-/, ""), 10);
    if (!Number.isInteger(seq)) {
      throw new ValidationError(`Operation targets "${handle}", which is not a cl-N handle.`);
    }
    const clause = await db.query.standardClauses.findFirst({
      where: and(
        eq(standardClauses.docId, standard.id),
        eq(standardClauses.seq, seq),
        ne(standardClauses.status, "deleted"),
      ),
    });
    if (!clause) {
      // Covers dec-3's check for `add`: a clause proposed relative to a clause that has
      // since been deleted has no defined position, so the accept refuses rather than
      // guessing — never an append-to-end fallback (ac-16).
      throw new ValidationError(
        op.op === "add"
          ? `${handle} — the clause this proposal adds next to — no longer exists on ${standard.handle}. Re-propose against the current rule.`
          : `${handle} no longer exists on ${standard.handle}. Re-propose against the current rule.`,
      );
    }
    if (clause.sectionId !== section.id) {
      throw new ValidationError(
        `${handle} has moved to a different section since this proposal was written. Re-propose against the current rule.`,
      );
    }
    resolved.push({ op, clause });
  }

  // An `add` anchored on a clause this same set deletes has no coherent meaning — the
  // anchor is gone by the time the add runs. Caught here, before any write, so the
  // refusal is total like every other (ac-10).
  const deletedHandles = new Set(
    resolved.filter((r) => r.op.op === "delete").map((r) => handleOf(r.clause)),
  );
  for (const { op, clause } of resolved) {
    if (op.op === "add" && deletedHandles.has(handleOf(clause))) {
      throw new ValidationError(
        `This proposal adds a clause next to ${handleOf(clause)} and also deletes ${handleOf(clause)}. Those cannot both hold — re-propose with a different anchor.`,
      );
    }
  }

  // ── dec-3's staleness guard: exact compare, before anything is written ──
  // The proposal is a stale read by nature — authored at T0, accepted at T1, possibly
  // after another agent edited that clause. Applying blind at T1 discards the
  // intervening edit silently, which is the failure class this whole Spec exists to
  // close. Comparison is EXACT, whitespace included: a "close enough" match reopens the
  // silent-overwrite class, and the cost of a false refusal is one re-proposal.
  for (const { op, clause } of resolved) {
    if (op.op === "add") continue; // no "before" to compare — its check is anchor-exists, above
    if (clause.body !== op.before) {
      throw new ValidationError(
        `${handleOf(clause)} changed after this proposal was written, so applying it would discard that change. ` +
          `It now reads:\n\n${clause.body}\n\nRe-propose against the current rule.`,
      );
    }
  }

  // ── Emit keys [per std-8] ──
  // One event per logical change, mirroring the composite the clause verbs already
  // emit, plus the pair the propose path fires: `comment` updated so an open Inbox row
  // clears, and `standard_drift` so the per-standard drift-count chip refetches. An
  // accept that does not emit is the same defect in miniature as the one being fixed —
  // the work happened and the surface still says it did not (ac-12).
  const keys: ChangeKey[] = [
    ...operations.map((op) => ({
      memexId,
      docId: standard.id,
      entity: "clause" as const,
      action:
        op.op === "add" ? ("created" as const) : op.op === "edit" ? ("updated" as const) : ("deleted" as const),
    })),
    { memexId, docId: standard.id, entity: "section", action: "updated" },
    { memexId, docId: standard.id, entity: "comment", action: "updated" },
    { memexId, docId: standard.id, entity: "standard_drift", action: "updated" },
  ];

  // Resolved once, before the transaction opens (an indexed users lookup), so the tx
  // stays free of a round trip — same idiom as the clause verbs. This is what makes the
  // rule change attributable: WHO accepted it and HOW [per std-32] (ac-20).
  const actor = await resolveActorColumns(ctx);

  return mutate(ctx, keys, async () =>
    db.transaction(async (tx) => {
      for (const { op, clause } of resolved) {
        if (op.op === "edit") {
          await updateClauseBodyTx(tx, clause.id, op.after);
        } else if (op.op === "delete") {
          await softDeleteClauseTx(tx, clause);
        } else {
          // ANCHOR → ORDINAL, resolved HERE and not at authoring time (ac-19). An
          // ordinal captured when the proposal was written is stale by construction: a
          // clause inserted ahead of the anchor shifts it, and nothing would detect
          // that. So the anchor's CURRENT position is re-read inside the transaction —
          // it may have moved since the pre-flight read, because an earlier operation
          // in this same set may have shifted it.
          const [current] = await tx
            .select()
            .from(standardClauses)
            .where(eq(standardClauses.id, clause.id));
          const ordinal = op.placement === "before" ? current.position : current.position + 1;
          // insertClauseTx shifts live siblings out of the way [per dec-5], so the new
          // clause lands next to its anchor with ordinals left unique and dense.
          await insertClauseTx(tx, memexId, section, op.body, ordinal);
        }
      }

      // Once, at the end — not per operation. The composed text is a function of the
      // final row set, so N regenerations would do the same work N times and only the
      // last one would matter.
      await regenerateSectionContentTx(tx, section, actor);

      // Resolving the proposal is part of the SAME transaction, which is the point of
      // the verb: there is no window in which the Standard is rewritten and the
      // proposal still open, or the reverse.
      const [updatedComment] = await tx
        .update(docComments)
        .set({ resolvedAt: new Date(), resolution: "accepted" })
        .where(and(eq(docComments.id, comment.id), eq(docComments.memexId, memexId)))
        .returning();

      return {
        standard,
        section,
        comment: updatedComment,
        applied: operations.length,
      };
    }),
  );
}
