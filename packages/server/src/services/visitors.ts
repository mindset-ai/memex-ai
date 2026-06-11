// Visitors store — the anonymous-first identity spine (spec-254 t-1).
//
// Two operations, both ADVISORY (a failure is logged and swallowed, never thrown
// back into the request) because identity capture must never break a user action,
// exactly like the usage-events sink:
//
//   recordVisitor — idempotent insert-on-first-sight. Keeps the original
//     first_seen_at on a repeat (ON CONFLICT DO NOTHING).
//   mergeVisitor  — the analytics "identify" step with the bind-once invariant
//     (spec-254 dec-3): a visitor_id binds to at most one user, ever.
//       unbound        → stamp user_id + merged_at        → { merged }
//       same user      → no-op                            → { already }
//       different user → DO NOT overwrite; caller mints a fresh id → { rebind }
//
// The merge is the embryo of spec-125's slowly-changing-dimension merge on
// dim_actor; this is the browser-only slice.

import { and, eq, isNull } from "drizzle-orm";
import { db, type Db } from "../db/connection.js";
import { visitors } from "../db/schema.js";
import type { Visitor } from "../db/schema.js";

function log(...args: unknown[]): void {
  // eslint-disable-next-line no-console
  console.error("[visitors]", ...args);
}

/**
 * Record first sight of a visitor_id. Idempotent — ON CONFLICT DO NOTHING keeps the
 * original first_seen_at, so a repeat sighting never resets the anonymous origin.
 * Advisory: a failed insert is logged and swallowed. Returns the row (existing or
 * new) or null on skip/failure.
 */
export async function recordVisitor(
  visitorId: string,
  conn: Db = db,
): Promise<Visitor | null> {
  if (typeof visitorId !== "string" || visitorId.length === 0) return null;
  try {
    await conn.insert(visitors).values({ visitorId }).onConflictDoNothing();
    const [row] = await conn.select().from(visitors).where(eq(visitors.visitorId, visitorId));
    return row ?? null;
  } catch (err) {
    log("recordVisitor failed (advisory — swallowed):", err instanceof Error ? err.message : err);
    return null;
  }
}

export type MergeStatus = "merged" | "already" | "rebind";

export interface MergeOutcome {
  /** merged: freshly bound. already: same user (no-op). rebind: bound to a
   *  DIFFERENT user — the binding was left intact and the caller must mint a
   *  fresh visitor_id for the new user. */
  status: MergeStatus;
  visitorId: string;
}

/**
 * The identify/alias step with the bind-once invariant (spec-254 dec-3). The bind
 * is an ATOMIC conditional update (WHERE user_id IS NULL) so two concurrent merges
 * can't both win. Advisory: a failure is logged and swallowed (returns null).
 *
 * userId MUST come from the authenticated session, never a client-supplied field.
 */
export async function mergeVisitor(
  visitorId: string,
  userId: string,
  conn: Db = db,
): Promise<MergeOutcome | null> {
  if (typeof visitorId !== "string" || visitorId.length === 0) return null;
  if (typeof userId !== "string" || userId.length === 0) return null;
  try {
    // The merge can be a visitor's very first sight (the auth POST arrives before
    // any prior recordVisitor on a fresh session), so ensure the row exists first.
    await conn.insert(visitors).values({ visitorId }).onConflictDoNothing();

    // Atomic bind-if-unbound: only stamps when still anonymous.
    const bound = await conn
      .update(visitors)
      .set({ userId, mergedAt: new Date() })
      .where(and(eq(visitors.visitorId, visitorId), isNull(visitors.userId)))
      .returning();
    if (bound.length > 0) return { status: "merged", visitorId };

    // Already bound — same user is an idempotent no-op; a different user must NOT
    // overwrite (bind-once), so the caller mints a fresh visitor_id for them.
    const [row] = await conn.select().from(visitors).where(eq(visitors.visitorId, visitorId));
    if (!row) return null;
    return row.userId === userId
      ? { status: "already", visitorId }
      : { status: "rebind", visitorId };
  } catch (err) {
    log("mergeVisitor failed (advisory — swallowed):", err instanceof Error ? err.message : err);
    return null;
  }
}
