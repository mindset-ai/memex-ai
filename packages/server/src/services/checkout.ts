// spec-371 rework — the durable, single-holder CHECKOUT record on the spec's own
// documents row (dec-5). This REPLACES the merged v1's presence-coupled claim:
// checkout is its own intentional, durable binding ("who has bound a working thread
// to this spec"), NOT the ephemeral presence plane ("who's merely looking now",
// which this spec no longer touches).
//
// One current holder per spec; a new checkout supersedes. The enforcement gate
// (dec-11, services/checkout-gate or the mutators) keys on checked_out_by +
// checked_out_at, both read here.

import { and, eq } from "drizzle-orm";
import { db } from "../db/connection.js";
import { documents, users } from "../db/schema.js";
import { actorName } from "./actor.js";

// ── THE ONE TUNABLE PARAMETER (dec-11, ac-21) ───────────────────────────────
// A spec held by ANOTHER user more recently than this is a "collision": the
// implicit-checkout path fails-soft and asks for an explicit takeover. Set it
// here, in one place.
export const CHECKOUT_COLLISION_WINDOW_MS = 10 * 60 * 1000; // 10 minutes

export interface CheckoutState {
  userId: string | null;
  at: Date | null;
  thread: string | null;
}

/** A recent-colleague collision: another user holds the spec within the window. */
export interface Collision {
  holderUserId: string;
  heldAt: Date;
  /** Milliseconds since they took it. */
  ageMs: number;
}

/** Read the current checkout state off the document (null when the doc is gone). */
export async function getCheckout(docId: string): Promise<CheckoutState | null> {
  const [row] = await db
    .select({
      userId: documents.checkedOutBy,
      at: documents.checkedOutAt,
      thread: documents.checkedOutThread,
    })
    .from(documents)
    .where(eq(documents.id, docId))
    .limit(1);
  if (!row) return null;
  return { userId: row.userId, at: row.at, thread: row.thread };
}

// Is the spec held by ANOTHER user within the collision window? Returns the
// collision, or null when it is free / held by `userId` / stale (older than the
// window → free to take over). Pure so the gate can unit-test every branch.
export function collisionAgainst(
  state: CheckoutState | null,
  userId: string,
  now: number = Date.now(),
  windowMs: number = CHECKOUT_COLLISION_WINDOW_MS,
): Collision | null {
  if (!state || !state.userId || !state.at) return null; // free
  if (state.userId === userId) return null; // mine
  const ageMs = now - state.at.getTime();
  if (ageMs > windowMs) return null; // stale → free to take over
  return { holderUserId: state.userId, heldAt: state.at, ageMs };
}

// Stamp the checkout columns: `userId` now holds the spec, from `thread`, as of
// `now`. A new holder SUPERSEDES the prior one (single holder, dec-5).
export async function stampCheckout(input: {
  docId: string;
  userId: string;
  thread?: string | null;
  now?: Date;
}): Promise<void> {
  await db
    .update(documents)
    .set({
      checkedOutBy: input.userId,
      checkedOutAt: input.now ?? new Date(),
      checkedOutThread: input.thread ?? null,
    })
    .where(eq(documents.id, input.docId));
}

// Reconcile checked_out_thread to the conversation UID once the hook reports it
// (dec-12). Only updates when `userId` currently holds the spec, so a stray report
// can't relabel another holder's checkout. The server can't see the conversation
// UID on a raw MCP call (dec-3), so it arrives here via the edit phone-home.
export async function setCheckoutThread(input: {
  docId: string;
  userId: string;
  thread: string;
}): Promise<void> {
  await db
    .update(documents)
    .set({ checkedOutThread: input.thread })
    .where(and(eq(documents.id, input.docId), eq(documents.checkedOutBy, input.userId)));
}

// Resolve a collision into the holder's display name + a whole-minutes age, for
// the takeover message shown to the human / handed to the agent (dec-11).
export async function describeCollision(
  c: Collision,
): Promise<{ holderName: string; minutesAgo: number }> {
  const [u] = await db
    .select({ name: users.name, email: users.email })
    .from(users)
    .where(eq(users.id, c.holderUserId))
    .limit(1);
  return {
    holderName: u ? actorName(u) : "another user",
    minutesAgo: Math.max(1, Math.round(c.ageMs / 60_000)),
  };
}

// Release: free the spec, but ONLY if `userId` currently holds it — so a stale
// unclaim from an old thread can't evict a newer holder. No-op otherwise.
export async function releaseCheckout(docId: string, userId: string): Promise<void> {
  await db
    .update(documents)
    .set({ checkedOutBy: null, checkedOutAt: null, checkedOutThread: null })
    .where(and(eq(documents.id, docId), eq(documents.checkedOutBy, userId)));
}
