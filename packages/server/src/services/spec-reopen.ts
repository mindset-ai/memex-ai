// spec-566 t-8 (dec-9) — reopening a closed Spec is an attributed act.
//
// dec-9 froze a done Spec's criteria (t-3's second `update_ac` guard) and named
// reopening as the sanctioned way back in. Reopening already worked — phases
// move — so what this adds is not the capability but the COST: a reason, an
// actor, and a count that shows.
//
// ── Why this is not optional ──
//
// If reopening stays free and silent it is simply the route around t-3's guard,
// and the guard buys nothing: reopen, edit the criterion the Spec had certified,
// close again, and no record anywhere says so. The guard and its escape hatch
// have to cost the same, or the hatch IS the path.
//
// ── Why at the seam, and not as a new `reopen_spec` verb ──
//
// `updateDocStatus` is where phases move, and the Done screen's Reopen button
// calls exactly that (`DocDocument.tsx`). A separate verb that recorded a reason
// would leave `update_doc`, the kanban drag out of Done, and that button as the
// unrecorded paths — the same failure in a new place. dec-10 settled this shape
// for the done-gate; this is its mirror, and the refusal is typed for the same
// reason: the board must be able to prompt rather than roll the card back.
//
// ── Not a duplicate of spec-179's status_changed row (t-8's fourth item) ──
//
// Checked rather than assumed. `updateDocStatus` already writes `{from, to}` to
// `activity_log`. That row has NO reason column, and `activity-log-sweep.ts`
// deletes it after `PULSE_RETENTION_DAYS` (default 30). Unnamed and expiring —
// the same gap dec-3 catalogued for retirements, and the same answer: the
// journal row carries the reason and outlives the sweep, while the activity row
// goes on doing its own job, which is the Pulse timeline.

import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "../db/connection.js";
import { specLifecycleEvents } from "../db/schema.js";
import { ValidationError } from "../types/errors.js";

/**
 * The machine-readable discriminator, mirroring `DONE_GATE_BLOCKED`.
 *
 * The Done screen's Reopen button and the board's drag out of Done both switch
 * on this to ask for a reason, instead of surfacing a bare failure.
 */
export const REOPEN_NEEDS_REASON = "REOPEN_NEEDS_REASON";

/** 400, and typed, so a surface can prompt rather than report a fault. */
export class ReopenNeedsReasonError extends ValidationError {
  constructor(message: string) {
    super(message, REOPEN_NEEDS_REASON);
  }
}

/**
 * Is this status change a reopen — leaving `done` on a Spec?
 *
 * Narrow on purpose: entering `done` costs nothing, and neither does any move
 * between the phases before it. Only the way back OUT of a closed Spec is
 * gated, because that is the only move dec-9's guard can be routed around.
 */
export function isReopen(docType: string, from: string, to: string): boolean {
  return docType === "spec" && from === "done" && to !== "done";
}

/**
 * The refusal's words — the outcome, not the worry [per std-53].
 *
 * Says what is blocked, why the reason is wanted, and exactly how to supply it.
 */
export function formatReopenRefusal(specRef: string): string {
  return (
    `This Spec is closed, and reopening it is a recorded act — it needs a stated reason.\n\n` +
    `Closing certified this Spec's criteria; reopening is how an honest correction gets made, ` +
    `and the reason is what separates that from quietly editing what was already certified. ` +
    `Your name, the time and your words are kept, and the reopen count renders beside this ` +
    `Spec's coverage from then on.\n\n` +
    `  update_doc({ ref: '${specRef}', status: 'verify', reason: '...' })`
  );
}

/**
 * How many times each Spec was reopened — rendered beside the superseded and
 * override counts (t-5's surfaces, via `coverageAnnotationLabels`).
 *
 * Cost [std-39]: one grouped COUNT over the slice
 * `spec_lifecycle_events_brief_id_created_at_idx` already serves, at most one
 * row per Spec on the page. Reopening is a rare, deliberate human act.
 */
export async function countReopensForBriefs(
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
        eq(specLifecycleEvents.kind, "spec_reopened"),
        inArray(specLifecycleEvents.briefId, briefIds as string[]),
      ),
    )
    .groupBy(specLifecycleEvents.briefId);

  for (const r of rows) {
    if (r.briefId) out.set(r.briefId, r.n);
  }
  return out;
}
