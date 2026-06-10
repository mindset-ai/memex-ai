// In-memory sliding-window rate limiter for auth endpoints. Not distributed — OK for a
// single-instance deployment; multi-replica prod needs a shared store (Redis) later.
//
// Usage:
//   const result = rateLimit("login", `${ip}|${email}`, { max: 5, windowMs: 15 * 60 * 1000 });
//   if (!result.ok) return c.json({ error, retryAfterSec: result.retryAfterSec }, 429);

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

interface Bucket {
  count: number;
  resetAt: number; // epoch ms when the window ends
}

// `buckets[scope][key]` maps a scope (e.g. "login") + a key (e.g. "1.2.3.4|alice@x.com")
// to its current counter. Stale buckets are evicted lazily on access.
const buckets = new Map<string, Map<string, Bucket>>();

function getScopeMap(scope: string): Map<string, Bucket> {
  let m = buckets.get(scope);
  if (!m) {
    m = new Map();
    buckets.set(scope, m);
  }
  return m;
}

export function rateLimit(
  scope: string,
  key: string,
  config: RateLimitConfig
): RateLimitResult {
  const now = Date.now();
  const scopeMap = getScopeMap(scope);

  const existing = scopeMap.get(key);
  if (!existing || existing.resetAt <= now) {
    scopeMap.set(key, { count: 1, resetAt: now + config.windowMs });
    return { ok: true, remaining: config.max - 1 };
  }

  if (existing.count >= config.max) {
    return {
      ok: false,
      remaining: 0,
      retryAfterSec: Math.max(1, Math.ceil((existing.resetAt - now) / 1000)),
    };
  }

  existing.count += 1;
  return { ok: true, remaining: config.max - existing.count };
}

// Test hook: wipe all counters so tests don't interfere with each other.
export function resetRateLimits(): void {
  buckets.clear();
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
