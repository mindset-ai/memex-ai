// Cross-instance sliding-window rate limiter for auth endpoints (spec-349).
//
// Counters live in the `rate_limit_counters` Postgres table, NOT in process
// memory. Prod runs on Cloud Run with up to 3 instances and no session affinity,
// so the old in-memory Map multiplied every limit by the instance count and reset
// on cold start — the brute-force / enumeration guarantee was defeated across
// instances (spec-345 perf-3). Redis was deliberately rejected for the bus
// (spec-156) to keep the zero-managed-dependency posture; we reuse Postgres here
// for the same reason.
//
// Each call is a SINGLE atomic `INSERT ... ON CONFLICT DO UPDATE ... RETURNING`,
// so concurrent requests across instances serialise on the row lock — no lost
// increments, no read-modify-write race. The window boundary (`reset_at`) and
// the "is this window still live?" comparison are both computed in-DB via now(),
// so instances agree regardless of clock skew.
//
// Usage:
//   const result = await rateLimit("login", `${ip}|${email}`, { max: 5, windowMs: 15 * 60 * 1000 });
//   if (!result.ok) return c.json({ error, retryAfterSec: result.retryAfterSec }, 429);

import { sql } from "drizzle-orm";
import { db } from "../db/connection.js";

export interface RateLimitConfig {
  /** Max attempts per window before blocking. */
  max: number;
  /** Window size in milliseconds. */
  windowMs: number;
}

export interface RateLimitResult {
  ok: boolean;
  /** Remaining attempts in the current window. */
  remaining: number;
  /** When the current window resets (ms until ok=true again). Only meaningful when ok=false. */
  retryAfterSec?: number;
}

/**
 * Atomically record one attempt against (scope, key) and report whether it is
 * within the limit. Cross-instance correct: the counter is a Postgres row, and
 * the increment is a single upsert so concurrent callers can't lose increments.
 *
 * The upsert:
 *   - inserts {count: 1, reset_at: now()+window} on first hit;
 *   - on conflict, if the existing window has expired (reset_at <= now()) it
 *     STARTS A FRESH window (count=1, new reset_at) — the sliding reset;
 *   - otherwise it increments, clamped at max+1 so a hammered key's count can't
 *     grow without bound (it only ever needs to read as "> max" once blocked).
 * RETURNING gives the post-increment count and the live retry-after, so the
 * ok/blocked decision is derived purely from DB state.
 */
export async function rateLimit(
  scope: string,
  key: string,
  config: RateLimitConfig
): Promise<RateLimitResult> {
  // Window length as a Postgres interval (milliseconds → supports sub-second
  // windows, which the unit tests exercise). make_interval has no ms arg, so we
  // multiply the 1-millisecond unit interval.
  const windowMs = config.windowMs;
  const maxPlusOne = config.max + 1;

  const rows = (await db.execute(sql`
    INSERT INTO rate_limit_counters (scope, key, count, reset_at)
    VALUES (${scope}, ${key}, 1, now() + (${windowMs} * INTERVAL '1 millisecond'))
    ON CONFLICT (scope, key) DO UPDATE SET
      count = CASE
        WHEN rate_limit_counters.reset_at <= now() THEN 1
        ELSE LEAST(rate_limit_counters.count + 1, ${maxPlusOne})
      END,
      reset_at = CASE
        WHEN rate_limit_counters.reset_at <= now()
          THEN now() + (${windowMs} * INTERVAL '1 millisecond')
        ELSE rate_limit_counters.reset_at
      END
    RETURNING
      count AS count,
      GREATEST(1, CEIL(EXTRACT(EPOCH FROM (reset_at - now()))))::int AS retry_after_sec
  `)) as unknown as Array<{ count: number; retry_after_sec: number }>;

  const row = rows[0];
  // Defensive: a RETURNING upsert always yields exactly one row. If the driver
  // ever hands back nothing, fail OPEN is the wrong call for a security control —
  // but a missing row here means the write didn't happen, so treat as allowed-
  // first-attempt to avoid locking every user out on an infra blip.
  const count = row?.count ?? 1;
  const retryAfterSec = row?.retry_after_sec ?? 1;

  if (count > config.max) {
    return { ok: false, remaining: 0, retryAfterSec };
  }
  return { ok: true, remaining: config.max - count };
}

// Test hook: wipe all counters so tests don't interfere with each other. Now a
// TRUNCATE of the shared table rather than clearing an in-memory Map.
export async function resetRateLimits(): Promise<void> {
  await db.execute(sql`TRUNCATE rate_limit_counters`);
}

// Pre-configured limits for the auth surface area. Tune per-endpoint.
export const AUTH_LIMITS = {
  signup: { max: 5, windowMs: 60 * 60 * 1000 }, // 5 per hour per IP
  login: { max: 5, windowMs: 15 * 60 * 1000 }, // 5 per 15min per IP+email
  magicLink: { max: 3, windowMs: 60 * 60 * 1000 }, // 3 per hour per email
  resendVerification: { max: 5, windowMs: 60 * 60 * 1000 }, // 5 per hour per user
  passwordReset: { max: 3, windowMs: 60 * 60 * 1000 }, // 3 per hour per email
  probe: { max: 30, windowMs: 60 * 1000 }, // 30 per minute per IP — generous; controls enumeration speed
  oauthRegister: { max: 10, windowMs: 60 * 60 * 1000 }, // 10 per hour per IP — anonymous DCR endpoint
  // spec-222 t-11 (dec-4 → ac-15): the anonymous /guide/v1/session mint is exposed
  // to the open internet. IP-keyed so a single visitor opening a few sessions is
  // fine, but a flood can't burn ElevenLabs/Anthropic budget. Shaped like
  // oauthRegister (the other anonymous endpoint) but more generous — a legit
  // visitor may legitimately re-mint per page (ac-23 per-page sessions).
  guideSession: { max: 20, windowMs: 60 * 60 * 1000 }, // 20 per hour per IP — anonymous public guide
} as const;
