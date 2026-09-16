// spec-566 t-2 (dec-1 option C) — the supersession verb.
//
// This Spec exists because rewriting an acceptance criterion is cheaper than
// satisfying it: one untraced `update_ac` call and the red badge is green. The
// verb here is the price. It does NOT change the criterion — it files a proposal
// that a human accepts, in the same queue standards proposals already use.
//
// ── What propose must NOT do, and why every line below is shaped by it ──
//
// If proposing moved the statement, or moved the badge, the cost would be back to
// zero and this whole Spec would be decoration. So propose writes exactly ONE row:
// a `plan_revision` comment on the criterion. The criterion's statement, status
// and verification verdict are untouched (ac-7).
//
// ── The "before" text is READ, never supplied (ac-8) ──
//
// Same guard spec-530 built for clauses: the server reads the live statement
// itself, so the accept can tell whether it moved underneath the proposal. A
// caller that could supply the "before" could forge agreement with a criterion it
// never read, and the staleness check would be comparing the proposal against
// itself. Supplying it is REFUSED rather than ignored — a silently dropped
// argument leaves the caller believing a guard ran.
//
// ── Where the proposal lives, and why the split (t-2's design point) ──
//
// The proposal is a comment targeting the criterion through `doc_comments.ac_id`
// (migration 0150). That column exists because ac-20's done-gate must NAME the
// criteria holding an unaccepted proposal — that is a QUERY, and a field a gate
// filters on is a column, not a line in a payload [per std-32]. The superseding
// DECISION is deliberately the other way round: it rides the payload, because
// nothing queries proposals BY decision — the accept addresses a proposal by its
// own id and reads the payload it already has in hand. If a reader ever needs
// "every proposal under decision X", that is the moment to promote it to a column,
// not before.

import { and, eq, isNull, sql } from "drizzle-orm";
import { db } from "../db/connection.js";
import { acs, acParentLinks, decisions, docComments } from "../db/schema.js";
import type { DocComment } from "../db/schema.js";
// Type-only, so it is erased at runtime and closes no import cycle back onto the
// AC service (which queries this module's proposals directly for the same reason).
import type { Ac, AcKind } from "./acs.js";
import { NotFoundError, ValidationError } from "../types/errors.js";
import { mutate, type Mutated, type RequestCtx } from "./mutate.js";
import { resolveActorColumns } from "./actor.js";
import { addAcComment } from "./comments.js";
import { recordLifecycleEvent } from "./lifecycle-journal.js";

/** Payload version, so a future shape change is detectable rather than ambiguous. */
export const AC_SUPERSESSION_SCHEMA_VERSION = 1;

const FENCE_OPEN = "~~~proposed-statement";
const FENCE_CLOSE = "~~~";

/** The decoded body of a supersession proposal. */
export interface AcSupersessionProposal {
  /** The statement as the SERVER read it when the proposal was filed. */
  before: string;
  /** The replacement, or null for a supersession that retires without replacing. */
  after: string | null;
  /** The superseding decision this supersession is made under [dec-6]. */
  decisionId: string;
}

export interface ProposeAcSupersessionInput {
  memexId: string;
  acId: string;
  /**
   * The superseding decision — MANDATORY [dec-6]. Resolved from a canonical
   * `…/specs/spec-N/decisions/dec-M` ref at the MCP boundary [per std-10]; this
   * layer takes the resolved id.
   */
  decisionId: string;
  /** The replacement text. Omit to supersede without a successor (ac-19's "where a replacement exists"). */
  proposedStatement?: string | null;
  rationale?: string;
  authorName?: string;
}

/** Render the proposal body: prose for a human, a fenced payload for the accept. */
function buildProposalBody(
  proposal: AcSupersessionProposal,
  rationale: string | undefined,
): string {
  const rat = rationale?.trim() ? rationale.trim() : "(no rationale provided)";
  const headline = proposal.after
    ? "**Proposed supersession** — replace this criterion's statement"
    : "**Proposed supersession** — retire this criterion with no replacement";
  return [
    headline,
    "",
    rat,
    "",
    FENCE_OPEN,
    JSON.stringify({ v: AC_SUPERSESSION_SCHEMA_VERSION, ...proposal }),
    FENCE_CLOSE,
  ].join("\n");
}

/**
 * Companion parser. Returns null when the comment is not a readable supersession
 * proposal — one corrupt row must not break the Drift Inbox for every other item
 * on the page (the shape `parseProposedChangeBody` already uses for clauses).
 */
export function parseAcSupersessionBody(body: string): AcSupersessionProposal | null {
  const start = body.indexOf(FENCE_OPEN);
  if (start === -1) return null;
  const from = start + FENCE_OPEN.length;
  const end = body.indexOf(FENCE_CLOSE, from);
  if (end === -1) return null;
  try {
    const decoded: unknown = JSON.parse(body.slice(from, end).trim());
    if (typeof decoded !== "object" || decoded === null) return null;
    const o = decoded as Record<string, unknown>;
    if (typeof o.before !== "string") return null;
    if (typeof o.decisionId !== "string") return null;
    if (o.after !== null && typeof o.after !== "string") return null;
    return { before: o.before, after: o.after, decisionId: o.decisionId };
  } catch {
    return null;
  }
}

/**
 * The open (unaccepted) supersession proposal on a criterion, or null.
 *
 * One at a time, by construction — `proposeAcSupersession` refuses a second while
 * one is open. That is what lets ac-20's refusal name a single criterion and a
 * single clearing call rather than an ambiguous list.
 */
export async function findOpenAcProposal(
  memexId: string,
  acId: string,
): Promise<DocComment | null> {
  const row = await db.query.docComments.findFirst({
    where: and(
      eq(docComments.memexId, memexId),
      eq(docComments.acId, acId),
      eq(docComments.commentType, "plan_revision"),
      isNull(docComments.resolvedAt),
    ),
  });
  return row ?? null;
}

/**
 * File a supersession proposal against a criterion. Changes nothing about the
 * criterion itself — see the header.
 */
export async function proposeAcSupersession(
  input: ProposeAcSupersessionInput,
  ctx: RequestCtx = {},
): Promise<Mutated<{ ac: Ac; comment: DocComment }>> {
  // ── Validation, HOISTED above the write it protects [per std-53] ──

  // ac-8. Checked on the raw object rather than the typed field set, because the
  // whole point is a caller sending something the contract does not have. Refused
  // with the reason, not dropped: a silently ignored "before" leaves the caller
  // believing the staleness guard compared against text they chose.
  const raw = input as unknown as Record<string, unknown>;
  for (const forbidden of ["before", "beforeStatement", "currentStatement", "statement"]) {
    if (raw[forbidden] !== undefined) {
      throw new ValidationError(
        `A supersession proposal must not carry the criterion's current text (\`${forbidden}\`). ` +
          "The server reads the live statement itself — that is what lets the accept detect the criterion moving underneath the proposal. Re-send without it.",
      );
    }
  }

  // dec-6: the decision ref is mandatory, and it is the ONLY pointer. There is no
  // successor argument — a replacement is reached by traversing this decision to
  // its child ACs (ac-19), so a second pointer that could disagree never exists.
  if (!input.decisionId?.trim()) {
    throw new ValidationError(
      "A supersession must name the decision it is made under — pass the superseding decision's canonical ref (…/specs/spec-N/decisions/dec-M). Reversing a criterion without a recorded reason is the quiet path this verb exists to close.",
    );
  }

  const ac = await db.query.acs.findFirst({
    where: and(eq(acs.id, input.acId), eq(acs.memexId, input.memexId)),
  });
  // std-7: a criterion in another memex is indistinguishable from one that does
  // not exist. Not found, never "not yours".
  if (!ac) throw new NotFoundError(`AC ${input.acId} not found`);

  if (ac.status === "superseded") {
    throw new ValidationError(
      "That criterion is already superseded. Propose against the criterion that replaced it, or reopen the question on a new decision.",
    );
  }

  const decision = await db.query.decisions.findFirst({
    where: and(eq(decisions.id, input.decisionId), eq(decisions.memexId, input.memexId)),
  });
  if (!decision) throw new NotFoundError(`Decision ${input.decisionId} not found`);
  if (decision.docId !== ac.briefId) {
    throw new ValidationError(
      "The superseding decision belongs to a different Spec than the criterion. A supersession is one Spec's business — record the decision on the Spec that owns the criterion.",
    );
  }

  // One open proposal per criterion. Two would make ac-20's refusal ambiguous
  // about which call clears the gate, and would let a reviewer accept a stale
  // proposal while a fresher one sat unread.
  const existing = await findOpenAcProposal(input.memexId, input.acId);
  if (existing) {
    throw new ValidationError(
      `That criterion already holds an unaccepted supersession proposal (c-${existing.seq}). Accept or reject it before filing another.`,
    );
  }

  const after = input.proposedStatement?.trim();
  if (input.proposedStatement !== undefined && input.proposedStatement !== null && !after) {
    throw new ValidationError(
      "A proposed replacement cannot be blank. Omit it entirely to supersede the criterion with no successor.",
    );
  }

  const body = buildProposalBody(
    {
      // Read from the live row — never from the caller (ac-8).
      before: ac.statement,
      after: after ?? null,
      decisionId: decision.id,
    },
    input.rationale,
  );

  // Two emits, mirroring the propose path spec-530 built for standards: the
  // comment create fires from inside addAcComment for anything subscribed to the
  // Spec, and `ac updated` fires here so the coverage surfaces re-read and show
  // the pending proposal (ac-7's visible half).
  return mutate(
    ctx,
    { memexId: input.memexId, docId: ac.briefId, entity: "ac", action: "updated" },
    async () => {
      const comment = await addAcComment(
        input.memexId,
        ac.id,
        input.authorName ?? "Memex agent",
        body,
        { type: "plan_revision", source: "agent" },
        ctx,
      );
      return { ac, comment };
    },
  );
}

// ══════════════════════════════════════════════════════════════════════
// Transaction-scoped AC writes (spec-566 t-2)
// ══════════════════════════════════════════════════════════════════════
//
// `createAc` and `transitionStatus` above each open their own `mutate()`, which is
// right for a standalone act and wrong for accepting a supersession: that accept
// retires one criterion, mints its successor, writes the lifecycle journal row and
// resolves the proposal, and a partial apply would leave a Spec whose criterion is
// superseded with nothing replacing it. So the accept runs ONE transaction and
// calls these, exactly as `standard-accept.ts` calls `clauses.ts`'s `…Tx` family.
//
// They live HERE, private to their one caller, rather than in acs.ts: a
// single-consumer symbol belongs in its consumer [per std-51], and keeping the
// writes inside this module's mutate() callback is also what keeps acs.ts OFF the
// mutate-coverage allowlist — that allowlist is file-granular, so an exemption on a
// service that big would blunt the std-8 guard for every future writer in it.
// They take the caller's `tx`;
// neither emits — the enclosing `mutate()` owns the bus contract [per std-8].

type AcTx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Per-Spec seq allocator, read through the CALLER's transaction. */
async function maxAcSeqTx(tx: AcTx, briefId: string): Promise<number> {
  const [row] = await tx
    .select({ maxSeq: sql<number>`coalesce(max(${acs.seq}), 0)` })
    .from(acs)
    .where(eq(acs.briefId, briefId));
  return row?.maxSeq ?? 0;
}

/**
 * Retire a criterion: `active` → `superseded`, statement untouched.
 *
 * The statement is deliberately NOT a parameter. ac-1 requires the original
 * "preserved verbatim"; a function that could write it is a function that will
 * eventually be asked to.
 */
async function supersedeAcTx(tx: AcTx, memexId: string, acId: string): Promise<Ac> {
  const [row] = await tx
    .update(acs)
    .set({ status: "superseded", updatedAt: new Date() })
    .where(and(eq(acs.id, acId), eq(acs.memexId, memexId)))
    .returning();
  if (!row) throw new NotFoundError(`AC ${acId} not found`);
  return row;
}

/**
 * Mint the replacement criterion, parented to the superseding decision.
 *
 * That parent link is the whole of ac-19's traversal: successor ACs are found by
 * walking the decision's children, so no successor pointer is stored on the
 * superseded criterion and no second pointer can disagree with it.
 *
 * Born with no test events, therefore `untested` — which is ac-4's verdict reset,
 * arrived at structurally. Nothing is deleted to achieve it: the old green stays
 * attached to the statement that earned it, on a criterion that has left the live
 * set (dec-2).
 */
async function createSuccessorAcTx(
  tx: AcTx,
  input: {
    memexId: string;
    briefId: string;
    kind: AcKind;
    statement: string;
    decisionId: string;
  },
  actor: Awaited<ReturnType<typeof resolveActorColumns>>,
): Promise<Ac> {
  const seq = (await maxAcSeqTx(tx, input.briefId)) + 1;
  const [row] = await tx
    .insert(acs)
    .values({
      memexId: input.memexId,
      briefId: input.briefId,
      seq,
      kind: input.kind,
      statement: input.statement,
      status: "active",
      ...actor,
    })
    .returning();
  await tx.insert(acParentLinks).values({
    acId: row.id,
    parentKind: "decision",
    parentId: input.decisionId,
  });
  return row;
}

/**
 * Record that the SUPERSEDED criterion also hangs off the superseding decision, so
 * the traversal has somewhere to start. Idempotent by intent: a criterion already
 * linked to that decision needs no second row.
 */
async function linkAcToDecisionTx(
  tx: AcTx,
  acId: string,
  decisionId: string,
): Promise<void> {
  const existing = await tx
    .select({ acId: acParentLinks.acId })
    .from(acParentLinks)
    .where(
      and(
        eq(acParentLinks.acId, acId),
        eq(acParentLinks.parentKind, "decision"),
        eq(acParentLinks.parentId, decisionId),
      ),
    );
  if (existing.length > 0) return;
  await tx.insert(acParentLinks).values({ acId, parentKind: "decision", parentId: decisionId });
}


export interface AcceptAcSupersessionResult {
  /** The criterion, now `superseded`, statement untouched. */
  superseded: Ac;
  /** The replacement, or null when the proposal retired without replacing. */
  successor: Ac | null;
  /** The now-resolved proposal comment. */
  comment: DocComment;
}

/**
 * Apply a supersession proposal and resolve it, in ONE transaction.
 *
 * Verb-for-verb the shape `services/standard-accept.ts` established, deliberately:
 * dec-1 put AC supersessions in the same human-accept queue as standards
 * proposals, and two resolution behaviours in one inbox is the inconsistency a
 * reviewer trips over. Every read and every check happens BEFORE anything is
 * written, so a mismatch refuses the whole thing rather than half-applying it.
 *
 * Takes the proposal's id and NOTHING else. The proposal already carries what will
 * be applied, so there is no argument through which a caller could apply something
 * other than what the human reviewed.
 */
export async function acceptAcSupersession(
  memexId: string,
  commentId: string,
  ctx: RequestCtx = {},
): Promise<Mutated<AcceptAcSupersessionResult>> {
  const comment = await db.query.docComments.findFirst({
    where: and(eq(docComments.id, commentId), eq(docComments.memexId, memexId)),
  });
  // std-7: a proposal in another memex is indistinguishable from one that does not
  // exist. Not found, never "not yours".
  if (!comment) throw new NotFoundError(`Proposal ${commentId} not found`);

  if (comment.commentType !== "plan_revision") {
    throw new ValidationError(
      `That comment is a ${comment.commentType}, not a proposal. Only a plan_revision carries a supersession to apply.`,
    );
  }
  if (comment.resolvedAt) {
    throw new ValidationError(
      "That proposal is already resolved — nothing to apply. Re-propose against the current criterion if the supersession is still wanted.",
    );
  }
  if (!comment.acId) {
    throw new ValidationError(
      "That proposal is not anchored to an acceptance criterion, so it has no target.",
    );
  }

  const proposal = parseAcSupersessionBody(comment.content);
  if (!proposal) {
    throw new ValidationError(
      "That proposal's body carries no readable supersession — it cannot be applied. Re-propose it.",
    );
  }

  const ac = await db.query.acs.findFirst({
    where: and(eq(acs.id, comment.acId), eq(acs.memexId, memexId)),
  });
  if (!ac) throw new NotFoundError(`AC ${comment.acId} not found`);
  if (ac.status === "superseded") {
    throw new ValidationError(
      "That criterion has already been superseded. Nothing left to apply — reject this proposal to clear it.",
    );
  }

  // ── The staleness guard [spec-530 dec-3], before anything is written ──
  // A proposal is a stale read by nature: authored at T0, accepted at T1, possibly
  // after the criterion moved. Applying blind at T1 would discard that change
  // silently — the exact failure class this Spec exists to close. EXACT compare,
  // whitespace included: "close enough" reopens the silent-overwrite class, and a
  // false refusal costs one re-proposal.
  if (ac.statement !== proposal.before) {
    throw new ValidationError(
      `This criterion changed after the supersession was proposed, so applying it would discard that change. ` +
        `It now reads:\n\n${ac.statement}\n\nRe-propose against the current criterion.`,
    );
  }

  // The superseding decision must still be there: it is what the successor hangs
  // off, and ac-19's traversal has no start without it.
  const decision = await db.query.decisions.findFirst({
    where: and(eq(decisions.id, proposal.decisionId), eq(decisions.memexId, memexId)),
  });
  if (!decision) {
    throw new ValidationError(
      "The decision this supersession was made under no longer exists. Re-propose it under a live decision — a supersession with no recorded reason is the quiet path this verb exists to close.",
    );
  }

  // Resolved before the transaction opens (an indexed users lookup), so the tx
  // carries no extra round trip — the idiom standard-accept.ts uses. This is what
  // makes the supersession attributable: WHO accepted it and HOW [per std-32].
  const actor = await resolveActorColumns(ctx);

  return mutate(
    ctx,
    [
      { memexId, docId: ac.briefId, entity: "ac", action: "updated" },
      ...(proposal.after
        ? [{ memexId, docId: ac.briefId, entity: "ac" as const, action: "created" as const }]
        : []),
      { memexId, docId: ac.briefId, entity: "comment", action: "updated" },
    ],
    async () =>
      db.transaction(async (tx) => {
        const superseded = await supersedeAcTx(tx, memexId, ac.id);

        // Both ends of ac-19's traversal, written here: the retired criterion hangs
        // off the decision so the walk has a start, and the successor hangs off the
        // same decision so the walk has an end.
        await linkAcToDecisionTx(tx, ac.id, decision.id);
        const successor = proposal.after
          ? await createSuccessorAcTx(
              tx,
              {
                memexId,
                briefId: ac.briefId,
                kind: ac.kind as "scope" | "implementation",
                statement: proposal.after,
                decisionId: decision.id,
              },
              actor,
            )
          : null;

        // t-1's journal, written by its FIRST caller. Inside this transaction and
        // through the same `tx`, so the record and the act commit together — a
        // supersession whose record failed must not stand [ac-16's sibling claim].
        await recordLifecycleEvent(
          {
            memexId,
            briefId: ac.briefId,
            acId: ac.id,
            kind: "ac_status_changed",
            reason: `Superseded under dec-${decision.seq} ("${decision.title}") by accepting proposal c-${comment.seq}.`,
            fromStatus: ac.status,
            toStatus: "superseded",
            actorUserId: actor.actorUserId ?? null,
            actorName: actor.actorName ?? null,
            channel: ctx.channel ?? "server",
          },
          tx,
        );

        // Resolving the proposal is part of the SAME transaction — there is no
        // window in which the criterion is superseded and the proposal still open,
        // or the reverse.
        const [updatedComment] = await tx
          .update(docComments)
          .set({ resolvedAt: new Date(), resolution: "accepted" })
          .where(and(eq(docComments.id, comment.id), eq(docComments.memexId, memexId)))
          .returning();

        return { superseded, successor, comment: updatedComment };
      }),
  );
}

/**
 * Decline a supersession proposal. The criterion is untouched; only the proposal
 * closes, with `resolution: 'rejected'` — the same vocabulary the standards accept
 * path uses, so one inbox has one set of outcomes.
 */
export async function rejectAcSupersession(
  memexId: string,
  commentId: string,
  ctx: RequestCtx = {},
): Promise<Mutated<DocComment>> {
  const comment = await db.query.docComments.findFirst({
    where: and(eq(docComments.id, commentId), eq(docComments.memexId, memexId)),
  });
  if (!comment) throw new NotFoundError(`Proposal ${commentId} not found`);
  if (comment.commentType !== "plan_revision" || !comment.acId) {
    throw new ValidationError(
      "That comment is not a supersession proposal on an acceptance criterion.",
    );
  }
  if (comment.resolvedAt) {
    throw new ValidationError("That proposal is already resolved — nothing to reject.");
  }

  return mutate(
    ctx,
    { memexId, docId: comment.docId, entity: "comment", action: "updated" },
    async () => {
      const [row] = await db
        .update(docComments)
        .set({ resolvedAt: new Date(), resolution: "rejected" })
        .where(and(eq(docComments.id, comment.id), eq(docComments.memexId, memexId)))
        .returning();
      return row;
    },
  );
}
