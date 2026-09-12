// spec-453 t-6 (dec-11) — the shared scheduled endpoint for timer-driven lifecycle
// emails. A Cloud Scheduler job hits POST /api/internal/lifecycle-tick once per day; one
// invocation runs BOTH spec-427's cohort drip (runActivationDrip) AND spec-453's "Connect
// with people" Day-12 pass (runConnectPeoplePass). This REPLACES the in-process
// setInterval that used to live in index.ts, which was unreliable on scale-to-zero Cloud
// Run (spec-427 issue-4): a single scheduled invocation is deterministic — no
// multi-instance duplicate race, no counter reset on cold start / deploy.
//
// AUTH (dec-11): the service is public (--allow-unauthenticated for the app + MCP), so
// Cloud Run cannot IAM-gate a single path. The endpoint therefore self-authenticates a
// shared bearer secret (LIFECYCLE_TICK_SECRET) with a timing-safe compare — the std-13
// hand-rolled idiom (mirrors services/storage/signed-token.ts, no new dependency). This
// is defense in depth: the real backstop against a stray or duplicated trigger is
// idempotency — every send dedups on its stable comms_log key (+ the atomic
// first_ac_verified_at gate for "See it verified"), so a re-run sends only the emails
// that would have gone anyway. An UNSET secret is fail-closed (nobody is authorised).
//
// RETRY-SAFE: the two passes are isolated (one throwing never skips the other); if either
// fails the handler returns 500 so Cloud Scheduler retries — safe precisely because both
// passes dedup, so the retry re-sends nothing already sent.

import { Hono } from "hono";
import { timingSafeEqual } from "node:crypto";
import { runActivationDrip } from "../services/email/activation-drip.js";
import { runConnectPeoplePass } from "../services/email/connect-people.js";

export const internalLifecycleRouter = new Hono();

/** Timing-safe bearer check against LIFECYCLE_TICK_SECRET. Fail-closed when unset. */
function authorized(authHeader: string | undefined): boolean {
  const secret = process.env.LIFECYCLE_TICK_SECRET;
  if (!secret) return false; // no secret configured → nobody is authorised
  const prefix = "Bearer ";
  if (!authHeader || !authHeader.startsWith(prefix)) return false;
  const provided = Buffer.from(authHeader.slice(prefix.length));
  const expected = Buffer.from(secret);
  // Length check first — timingSafeEqual throws on unequal lengths.
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}

/**
 * The Connect pass go-live instant (dec-10). MUST be the SAME deploy-time moment t-1's
 * migration backfilled users.first_ac_verified_at to, so "See it verified" and "Connect
 * with people" agree on when go-live was. Read from ACTIVATION_CONNECT_GO_LIVE (ISO).
 * Absent/invalid → return null and SKIP the Connect pass (never throw, never blast the
 * back-catalog) while the cohort drip still runs.
 */
function connectGoLiveAt(): Date | null {
  const raw = process.env.ACTIVATION_CONNECT_GO_LIVE;
  if (!raw) return null;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d;
}

internalLifecycleRouter.post("/lifecycle-tick", async (c) => {
  if (!authorized(c.req.header("authorization"))) {
    return c.json({ error: "unauthorized" }, 401);
  }

  const now = new Date();
  const result: {
    drip?: unknown;
    connect?: unknown;
    errors: string[];
  } = { errors: [] };

  // Isolate each pass so one failing never skips the other. Both are flag-gated
  // (ACTIVATION_EMAILS_ENABLED) internally, so this is a no-op while the sequence is off.
  try {
    result.drip = await runActivationDrip(now);
  } catch (err) {
    result.errors.push(`drip: ${err instanceof Error ? err.message : String(err)}`);
  }

  const goLive = connectGoLiveAt();
  if (goLive) {
    try {
      result.connect = await runConnectPeoplePass(goLive, now);
    } catch (err) {
      result.errors.push(`connect: ${err instanceof Error ? err.message : String(err)}`);
    }
  } else {
    result.connect = { skipped: "ACTIVATION_CONNECT_GO_LIVE unset or invalid" };
  }

  // Non-200 on any failure → Cloud Scheduler retries (idempotent-safe via per-pass dedup).
  return c.json(result, result.errors.length ? 500 : 200);
});
