// spec-203 Layer 2 (dec-2): the module-local store that decides WHEN the in-chat
// footer machine delivers the FULL phase handoff (the ~1500-word copy-button
// prompt) versus the compressed essence (Layer 1, every other response).
//
// The full handoff rides the footer ONCE per (user, session, spec, phase) —
// re-firing automatically on phase change (phase is part of the key) and after a
// TTL idle backstop. Keyed on the `session_id` the MCP dispatch already carries:
// prod telemetry (spec-203 dec-2) showed 99.7% of real tool traffic reuses one
// stable session_id across a working session, so a continuous session is primed
// once per phase and shown the essence thereafter.
//
// Process-local, mirroring phase-assessment.ts's `recentAssessments` Map: fine
// for a single Cloud Run instance, and cross-instance loss only causes a benign
// re-delivery (the full handoff shown again). Per dec-2 we bias toward
// delivering — never priming the agent is the costly failure, re-showing is
// cheap. If we ever need cross-instance precision, swap for Redis.

const lastFullDelivery = new Map<string, number>();

// TTL backstop. Per spec-203 dec-2 this is POLISH, not load-bearing: session_id
// is stable across ~99-min sessions, so within one session+phase the full is
// delivered once and the essence thereafter — the TTL only re-primes a session
// that returns after a long idle gap (or after cross-instance store loss).
export const FULL_HANDOFF_TTL_MS = 30 * 60 * 1000;

function deliveryKey(
  userId: string,
  sessionId: string,
  specId: string,
  phase: string,
): string {
  return `${userId}:${sessionId}:${specId}:${phase}`;
}

/**
 * Check-and-claim: returns true (and records `now`) when the full handoff SHOULD
 * ride this response — it has not been delivered for this (user, session, spec,
 * phase) yet, or the TTL backstop has elapsed since the last delivery. Returns
 * false when a recent delivery means the footer should carry the compressed
 * essence instead. Atomic (synchronous check-and-set) so two concurrent calls on
 * one instance cannot both claim the same delivery.
 */
export function claimFullHandoffDelivery(
  userId: string,
  sessionId: string,
  specId: string,
  phase: string,
  now: number = Date.now(),
  ttlMs: number = FULL_HANDOFF_TTL_MS,
): boolean {
  const key = deliveryKey(userId, sessionId, specId, phase);
  const last = lastFullDelivery.get(key);
  if (last !== undefined && now - last < ttlMs) return false;
  lastFullDelivery.set(key, now);
  return true;
}

/** Test-only escape hatch — clears the delivery store so cross-test state can't
 *  leak. Production never calls it. */
export function _clearHandoffDeliveries(): void {
  lastFullDelivery.clear();
}
