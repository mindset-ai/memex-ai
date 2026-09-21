// spec-203 Layer 2 (dec-2): decides WHEN the in-chat footer machine delivers the
// FULL phase handoff (the ~1500-word copy-button prompt) versus the compressed
// essence (Layer 1, every other response).
//
// The full handoff rides the footer ONCE per (user, session, spec, phase) —
// re-firing automatically on phase change (phase is part of the key) and after a
// TTL idle backstop. Keyed on the `session_id` the MCP dispatch already carries:
// prod telemetry (spec-203 dec-2) showed 99.7% of real tool traffic reuses one
// stable session_id across a working session, so a continuous session is primed
// once per phase and shown the essence thereafter.
//
// ── STORAGE: MIGRATED TO THE SHARED STORE (spec-510 t-4, dec-7) ──────────────
//
// This module used to reason that process-local state was fine here, because
// "cross-instance loss only causes a benign re-delivery". That was sound
// reasoning on an UNCHECKED PREMISE, and spec-510 dec-7 checked it: measured over
// 30 days to 2026-07-27, delivery runs at **2.672x per (user, session, spec,
// phase)** against a contract of 1 — 1,151 of 1,659 re-deliveries unexplained by
// the TTL below, median gap 36 seconds. 2.672 is about the Cloud Run instance
// count. The re-delivery was not occasional; it was most of the time, and each
// one re-sends ~1,500 words to an agent that already had them.
//
// The claim now lives in `agent_session_claims` (migration 0152, see
// services/session-claims.ts) under the `handoff:*` namespace, so instances share
// one answer. spec-203 is `done` — its dec-2 is superseded here, not retro-edited;
// the supersession is recorded in spec-510 dec-7 and issue-3.
//
// ── THE RETREAT PATH (spec-510 dec-9) ───────────────────────────────────────
//
// The process-local Map BELOW IS NOT DEAD CODE. It is the OFF path of
// HANDOFF_SHARED_STORE_ENABLED, and dec-9 required it: this is the only part of
// spec-510 that changes shipped code working as designed, so its "off" has to
// mean something rather than nothing. The failure it guards is silent by
// construction — no error, no red test, no log line, just agents less well primed
// at phase transitions — and the dangerous reading is **0 deliveries per group,
// not 2.672**.
//
// dec-9 accepted the cost explicitly: two stores really do coexist during the
// deprecation window. What dec-7 rejected was PERMANENT, UNDECLARED coexistence
// where nobody knows which governs what. This one is temporary, deliberate and
// dated. **Both the Map and the flag come out together** once the migration is
// confirmed in production.

import { claimOnce } from "./session-claims.js";

const lastFullDelivery = new Map<string, number>();

// TTL backstop. Per spec-203 dec-2 this is POLISH, not load-bearing: session_id
// is stable across ~99-min sessions, so within one session+phase the full is
// delivered once and the essence thereafter — the TTL only re-primes a session
// that returns after a long idle gap.
export const FULL_HANDOFF_TTL_MS = 30 * 60 * 1000;

/** The env var gating where the claim lives (spec-510 dec-9). */
export const HANDOFF_SHARED_STORE_FLAG = "HANDOFF_SHARED_STORE_ENABLED";

const ON_VALUES = new Set(["1", "true", "yes", "on"]);

/**
 * ON  → the shared persisted session row (the corrected behaviour).
 * OFF → the process-local Map below (today's behaviour, defect and all).
 *
 * Explicit, default OFF, read LIVE rather than cached at import — following
 * services/email/activation-flag.ts. Read live is the point: flipping this is a
 * kill switch that takes effect on the next call, with no deploy. It must also
 * pass through `scripts/deploy-config.sh` with set-vs-unset semantics, or the
 * next deploy silently resets a hand-set switch — "a switch that looks armed and
 * is not" (dec-6), which is the worst outcome for a guard against a silent
 * failure.
 */
export function handoffSharedStoreEnabled(): boolean {
  return ON_VALUES.has((process.env[HANDOFF_SHARED_STORE_FLAG] ?? "").trim().toLowerCase());
}

/**
 * The claim key inside the session row.
 *
 * dec-7 wrote this namespace as `handoff:{spec}:{phase}`, and the row is already
 * keyed by session — but the SHIPPED key is (user, session, spec, phase). USER IS
 * KEPT because dropping it would silently under-deliver for a second user sharing
 * one session id, and the contract for this task is that only the STORAGE moves.
 * A narrower key is a behaviour change wearing a refactor's clothes.
 */
export function handoffClaimKey(userId: string, specId: string, phase: string): string {
  return `handoff:${userId}:${specId}:${phase}`;
}

function deliveryKey(
  userId: string,
  sessionId: string,
  specId: string,
  phase: string,
): string {
  return `${userId}:${sessionId}:${specId}:${phase}`;
}

/**
 * Check-and-claim: resolves true when the full handoff SHOULD ride this response
 * — it has not been delivered for this (user, session, spec, phase) yet, or the
 * TTL backstop has elapsed since the last delivery. False means the footer should
 * carry the compressed essence instead.
 *
 * ⚠ ASYNC since spec-510 t-4. The caller keeps it LAST in its `&&` chain so the
 * claim is only made when a handoff would actually be delivered — awaiting it
 * unconditionally would consume claims on responses that deliver nothing (and
 * `HANDOFF_BUTTON_BY_PHASE` is a Partial: draft and done have no handoff at all).
 *
 * `now` drives the OFF path only. On the shared path time is computed IN-DB via
 * `now()`, deliberately: that is what lets instances agree regardless of clock
 * skew, and it is why the shared path cannot be driven by an injected clock.
 */
export async function claimFullHandoffDelivery(
  userId: string,
  sessionId: string,
  specId: string,
  phase: string,
  now: number = Date.now(),
  ttlMs: number = FULL_HANDOFF_TTL_MS,
): Promise<boolean> {
  if (handoffSharedStoreEnabled()) {
    return claimOnce(sessionId, handoffClaimKey(userId, specId, phase), { ttlMs });
  }

  // OFF path — unchanged from spec-203, including the injected clock. Atomic by
  // being synchronous, which is exactly as far as a process-local Map can get:
  // two concurrent calls on ONE instance cannot both claim, and two instances
  // always can. That is the defect, preserved here on purpose as the retreat.
  const key = deliveryKey(userId, sessionId, specId, phase);
  const last = lastFullDelivery.get(key);
  if (last !== undefined && now - last < ttlMs) return false;
  lastFullDelivery.set(key, now);
  return true;
}

/** Test-only escape hatch — clears the OFF path's store. It does NOT touch the
 *  shared store (use `_resetSessionClaims` for that, or worker-unique session ids
 *  [per std-37]). Production never calls it. */
export function _clearHandoffDeliveries(): void {
  lastFullDelivery.clear();
}
