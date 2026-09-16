// spec-566 t-1 (dec-3) — the Spec lifecycle journal.
//
// The durable record of acts that REMOVE or REVERSE something: a test's evidence
// retired (t-4), an AC's status transitioned (t-6), the done-gate overridden
// (t-7), a closed Spec reopened (t-8). One table, four writers, `kind` telling
// them apart — dec-3 ruled it is BUILT ONCE.
//
// ── The one property that makes this different from activity_log ──
//
// `persistEvent` (services/activity-log.ts) states it swallows its own failures
// so the originating emitter is never affected. THIS MODULE MUST NOT. A record
// permitted to silently not exist is not a record, and every consumer of this
// journal (ac-5's retirement trace, dec-2's coverage history, dec-7's override
// count) reads absence as "it never happened". So `recordLifecycleEvent` throws,
// and the act it accompanies fails with it.
//
// ── Why it takes a `conn` and does not call mutate() ──
//
// Each write here is part of an ENCLOSING mutation, not a mutation of its own:
// t-4 calls it inside `discontinueTestEventsForAc`'s `mutate()` callback, inside
// the same transaction that hard-deletes the test_events rows. Nesting mutate()
// inside mutate() would double-emit on the bus and, worse, let the journal row
// commit while its operation rolled back. Passing the caller's `tx` is what makes
// "the record and the act commit together" true rather than aspirational.
//
// That is why this file carries an allowlist entry in the std-8 mutate-coverage
// static scan, with the same justification `services/clauses.ts` carries for
// `regenerateSectionContentTx`: a tx-helper reached only from inside a mutate()
// callback, which the callback-scoped heuristic cannot follow.

import { db, type Db } from "../db/connection.js";
import {
  specLifecycleEvents,
  type SpecLifecycleEvent,
} from "../db/schema.js";
import { ValidationError } from "../types/errors.js";

/** The four acts this journal records. Mirrors the DB CHECK. */
export type LifecycleEventKind =
  | "test_retired"
  | "ac_status_changed"
  | "gate_overridden"
  | "spec_reopened";

export interface LifecycleEventInput {
  memexId: string;
  /** The owning Spec (std-32's coarse WHAT). Null only once the Spec is deleted. */
  briefId?: string | null;
  /** The criterion this act concerns — retirements and status changes. */
  acId?: string | null;
  kind: LifecycleEventKind;
  /** WHY. Non-blank, always: a judgement with no stated reason is the quiet path. */
  reason: string;
  commitSha?: string | null;
  /** Required when kind === 'test_retired' — the DB CHECK enforces it too. */
  testIdentifier?: string | null;
  /**
   * spec-566 t-4 — the canonical AC ref the retired evidence was tagged to, kept
   * verbatim. `acId` is the join and degrades to NULL when the criterion is
   * deleted; this is the name, and it does not.
   */
  subjectRef?: string | null;
  fromStatus?: string | null;
  toStatus?: string | null;
  actorUserId?: string | null;
  /** Denormalised at write [std-32] so a later rename cannot rewrite history. */
  actorName?: string | null;
  channel: "rest_ui" | "mcp" | "in_app_agent" | "server";
}

/**
 * Append one immutable row. Throws on any failure — the caller's operation fails
 * with it.
 *
 * Pass the enclosing transaction as `conn` so the record and the act it records
 * commit together. Omitting it writes on the default connection, which is correct
 * only for a standalone act with nothing to be atomic with.
 *
 * There is deliberately no update and no delete in this module, and no restore
 * path anywhere: the journal is write-once (ac-17, scanned).
 */
export async function recordLifecycleEvent(
  input: LifecycleEventInput,
  conn: Db = db,
): Promise<SpecLifecycleEvent> {
  // Validation HOISTED above the write it protects [per std-53] — a guarded
  // validation is an accepted invalid input. The DB CHECKs are the backstop for
  // a caller that reaches the table another way; these are the readable errors.
  if (!input.reason?.trim()) {
    throw new ValidationError(
      "A lifecycle event needs a reason — an unexplained retirement, override or reopen is the quiet path this journal exists to close.",
    );
  }
  if (input.kind === "test_retired" && !input.testIdentifier?.trim()) {
    throw new ValidationError(
      "A test retirement must name the test identifier it retired.",
    );
  }

  const [row] = await conn
    .insert(specLifecycleEvents)
    .values({
      memexId: input.memexId,
      briefId: input.briefId ?? null,
      acId: input.acId ?? null,
      kind: input.kind,
      reason: input.reason.trim(),
      commitSha: input.commitSha ?? null,
      testIdentifier: input.testIdentifier ?? null,
      subjectRef: input.subjectRef ?? null,
      fromStatus: input.fromStatus ?? null,
      toStatus: input.toStatus ?? null,
      actorUserId: input.actorUserId ?? null,
      actorName: input.actorName ?? null,
      channel: input.channel,
    })
    .returning();

  // A driver that returned nothing is a failed write wearing a success. Say so
  // rather than handing back undefined for a caller to trip over later.
  if (!row) {
    throw new Error(
      "lifecycle journal: insert returned no row — the act it records must not be treated as recorded",
    );
  }
  return row;
}
