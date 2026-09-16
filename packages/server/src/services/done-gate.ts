// spec-566 t-7 (dec-7, dec-10) — the done-gate, and the attributed act that clears it.
//
// dec-7 option C: closing a Spec that holds an unaccepted supersession proposal
// is REFUSED by default, and a human may proceed through an explicit, attributed
// override that is recorded and counted.
//
// ── The condition is deliberately simple ──
//
// dec-8 chose to close the second door (`update_ac` refuses on a verified
// criterion) rather than build a change detector, so this gate asks exactly one
// question: does the Spec hold a supersession proposal no human has accepted or
// rejected? No prior statement text, no hash, no verification-relative timestamp
// — ac-25's source scan (t-10) exists to keep it that way, because a detector
// added later "for safety" reintroduces the false-positive class dec-8
// eliminated.
//
// ── Where it refuses, and why that was a decision ──
//
// dec-10 put the refusal in `updateDocStatus`, the single seam the kanban, MCP
// and the lifecycle path all funnel through, so the cheapest exit is the
// attributed one rather than a drag nobody records. That reopens ground spec-391
// once lost: it made verify→done a hard block at the same seam and was reverted
// because a card snapping back to its old column is an unacceptable board
// experience. The difference is `DONE_GATE_BLOCKED` — the refusal is TYPED, so
// the board can tell a gate from a server fault and open the override dialog
// instead of rolling back in silence (ac-29). An untyped refusal here would
// reproduce the reverted behaviour exactly.
//
// ── What an override clears, and what re-arms the gate ──
//
// An override clears the proposals that existed WHEN IT WAS MADE. A proposal
// filed afterwards re-arms the gate. The alternative — a permanent per-Spec
// exemption — would let one override at the start of a Spec's life license every
// unaccepted rewrite for the rest of it, which is the decay dec-7's count exists
// to prevent.

import { and, desc, eq, gt, inArray, isNull, sql } from "drizzle-orm";
import { db } from "../db/connection.js";
import { acs, docComments, documents, memexes, namespaces, specLifecycleEvents } from "../db/schema.js";
import { ConflictError, NotFoundError, ValidationError } from "../types/errors.js";
import { recordLifecycleEvent } from "./lifecycle-journal.js";
import { mutate, type Mutated, type RequestCtx } from "./mutate.js";
import { resolveActorColumns } from "./actor.js";

/**
 * The machine-readable discriminator dec-10 requires (ac-29).
 *
 * The board switches on this to tell "the gate refused" from "the request
 * failed", which is the whole reason a block at this seam is survivable this
 * time. Exported so the UI's copy of the constant has a source rather than a
 * duplicated string literal.
 */
export const DONE_GATE_BLOCKED = "DONE_GATE_BLOCKED";

export interface GateBlocker {
  /** The criterion whose rewrite is unaccepted. */
  acId: string;
  acSeq: number;
  statement: string;
  /** The proposal comment, for the accept/reject call the refusal names. */
  commentSeq: number;
}

/**
 * The criteria blocking closure: those holding an unaccepted supersession
 * proposal filed since the most recent override.
 *
 * Empty for every Spec that has never had one, which is every Spec today — the
 * gate costs a single indexed read and then gets out of the way.
 */
export async function listDoneGateBlockers(
  memexId: string,
  briefId: string,
): Promise<GateBlocker[]> {
  // The watermark: proposals predating the latest override were cleared by it.
  const [lastOverride] = await db
    .select({ at: specLifecycleEvents.createdAt })
    .from(specLifecycleEvents)
    .where(
      and(
        eq(specLifecycleEvents.memexId, memexId),
        eq(specLifecycleEvents.briefId, briefId),
        eq(specLifecycleEvents.kind, "gate_overridden"),
      ),
    )
    .orderBy(desc(specLifecycleEvents.createdAt))
    .limit(1);

  const rows = await db
    .select({
      acId: acs.id,
      acSeq: acs.seq,
      statement: acs.statement,
      commentSeq: docComments.seq,
    })
    .from(docComments)
    .innerJoin(acs, eq(acs.id, docComments.acId))
    .where(
      and(
        eq(docComments.memexId, memexId),
        eq(acs.briefId, briefId),
        eq(docComments.commentType, "plan_revision"),
        isNull(docComments.resolvedAt),
        lastOverride ? gt(docComments.createdAt, lastOverride.at) : undefined,
      ),
    )
    .orderBy(acs.seq);

  return rows.map((r) => ({
    acId: r.acId,
    acSeq: r.acSeq,
    statement: r.statement,
    commentSeq: r.commentSeq,
  }));
}

/**
 * The refusal's words.
 *
 * States the OUTCOME, not the worry [per std-53]: what is blocked, WHICH
 * criterion blocks it, and the exact calls that clear it. "This Spec has
 * unresolved issues" is a defect — dec-7 says so in as many words.
 */
export function formatDoneGateRefusal(specRef: string, blockers: GateBlocker[]): string {
  const one = blockers.length === 1;
  const named = blockers
    .map((b) => `  • ac-${b.acSeq} — "${b.statement}" (proposal c-${b.commentSeq})`)
    .join("\n");
  return (
    `This Spec cannot close: ${blockers.length} criteri${one ? "on holds" : "a hold"} a supersession ` +
    `proposal no one has accepted.\n\n${named}\n\n` +
    `Closing now would certify ${one ? "a criterion" : "criteria"} whose rewrite was never agreed. ` +
    `Clear it by deciding the proposal:\n` +
    `  accept_ac_supersession({ ref: '${specRef}/acs/ac-${blockers[0]!.acSeq}' })\n` +
    `  reject_ac_supersession({ ref: '${specRef}/acs/ac-${blockers[0]!.acSeq}' })\n\n` +
    `Or proceed anyway on the record — who, when and why are kept and counted beside this Spec's coverage:\n` +
    `  override_done_gate({ ref: '${specRef}', reason: '...' })`
  );
}

/** Thrown by the seam. 409, and carrying `DONE_GATE_BLOCKED` so the board can act on it. */
export class DoneGateBlockedError extends ConflictError {
  readonly blockers: GateBlocker[];
  constructor(message: string, blockers: GateBlocker[]) {
    super(message, DONE_GATE_BLOCKED);
    this.blockers = blockers;
  }
}

/**
 * Refuse the transition when the Spec holds an unaccepted proposal. Called by
 * `updateDocStatus` before it writes.
 *
 * Hoisted above the write it protects [per std-53] — a gate evaluated after the
 * status flip is an accepted close wearing a refusal.
 */
export async function assertDoneGateClear(memexId: string, briefId: string): Promise<void> {
  const blockers = await listDoneGateBlockers(memexId, briefId);
  if (blockers.length === 0) return;

  // The ref is resolved only on the refusing path. Every Spec that closes
  // cleanly — which is every Spec today — pays one indexed read and nothing
  // else [std-39].
  const [row] = await db
    .select({
      namespace: namespaces.slug,
      memex: memexes.slug,
      handle: documents.handle,
    })
    .from(documents)
    .innerJoin(memexes, eq(memexes.id, documents.memexId))
    .innerJoin(namespaces, eq(namespaces.id, memexes.namespaceId))
    .where(eq(documents.id, briefId))
    .limit(1);
  const specRef = row
    ? `${row.namespace}/${row.memex}/specs/${row.handle}`
    : "<this-spec>";

  throw new DoneGateBlockedError(formatDoneGateRefusal(specRef, blockers), blockers);
}

/**
 * Proceed anyway, on the record.
 *
 * `canEdit`, not owner-only (dec-10): an override is a DISPOSITION, and
 * spec-182 dec-4 split Issue powers the same way — raising stayed `canWrite`,
 * dispositions moved to `canEdit`. Authorisation is enforced at the route/tool
 * boundary, which is where the posture lives; a Spec outside the caller's reach
 * 404s there [std-7] rather than 403ing.
 */
export async function overrideDoneGate(
  memexId: string,
  briefId: string,
  reason: string,
  ctx: RequestCtx = {},
): Promise<Mutated<{ overriddenCount: number }>> {
  // Validation HOISTED above the write [per std-53].
  if (!reason?.trim()) {
    throw new ValidationError(
      "An override needs a stated reason — it closes a Spec over a criterion whose rewrite nobody accepted, and the reason is the only thing that makes that act reviewable rather than invisible.",
    );
  }

  const doc = await db.query.documents.findFirst({
    where: and(eq(documents.id, briefId), eq(documents.memexId, memexId)),
  });
  if (!doc) throw new NotFoundError(`Document ${briefId} not found`);

  const blockers = await listDoneGateBlockers(memexId, briefId);
  if (blockers.length === 0) {
    // Refusing the no-op is deliberate. An override recorded against nothing
    // inflates the count dec-7 relies on as its anti-decay signal, and a Spec
    // reading "1 override" with nothing overridden is worse than no count.
    throw new ValidationError(
      "There is nothing to override — this Spec holds no unaccepted supersession proposal, so closing it is not blocked.",
    );
  }

  const actor = await resolveActorColumns(ctx);

  return mutate(
    ctx,
    [
      {
        memexId,
        docId: briefId,
        entity: "document",
        action: "updated",
        narrative: `overrode the done-gate on ${doc.handle}`,
      },
    ],
    async () => {
      await recordLifecycleEvent({
        memexId,
        briefId,
        // The gate is a Spec-level act even though criteria are what block it;
        // `acId` stays null and the reason names what was overridden.
        acId: null,
        kind: "gate_overridden",
        reason: reason.trim(),
        actorUserId: actor.actorUserId ?? null,
        actorName: actor.actorName ?? null,
        channel: ctx.channel ?? "server",
      });
      return { overriddenCount: blockers.length };
    },
  );
}

/**
 * How many times each Spec's done-gate was overridden — dec-7's anti-decay
 * signal, rendered beside coverage on every surface the superseded count
 * appears on (ac-22).
 *
 * Cost [std-39]: one grouped COUNT over the slice `spec_lifecycle_events_brief_id_created_at_idx`
 * already serves, returning at most one row per Spec on the page. Overrides are a
 * rare deliberate human act, so the slice is tiny.
 */
export async function countGateOverridesForBriefs(
  memexId: string,
  briefIds: readonly string[],
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  for (const id of briefIds) out.set(id, 0);
  if (briefIds.length === 0) return out;

  const rows = await db
    .select({ briefId: specLifecycleEvents.briefId, n: sql<number>`count(*)::int` })
    .from(specLifecycleEvents)
    .where(
      and(
        eq(specLifecycleEvents.memexId, memexId),
        eq(specLifecycleEvents.kind, "gate_overridden"),
        inArray(specLifecycleEvents.briefId, briefIds as string[]),
      ),
    )
    .groupBy(specLifecycleEvents.briefId);

  for (const r of rows) {
    if (r.briefId) out.set(r.briefId, r.n);
  }
  return out;
}
