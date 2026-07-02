import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  rateLimit,
  resetRateLimits,
  AUTH_LIMITS,
} from "./auth-rate-limit.js";

// Coverage for the cross-instance (Postgres-backed) rate limiter (spec-349).
// The counter lives in the `rate_limit_counters` table, NOT in process memory,
// so these tests run against the real test DB. Each test truncates the table
// first so ordering doesn't matter. Keys are randomised per test so parallel
// workers (which share neither table — each owns a private DB clone — but run
// the same file) never collide on a key within a clone.

let n = 0;
function uniqueKey(label = "key"): string {
  // Worker-unique-ish: include the worker id and a monotonic counter so two
  // tests in the same file never reuse a (scope,key) row (std-37).
  const worker = process.env.VITEST_POOL_ID ?? "0";
  return `${label}-w${worker}-${n++}-${Math.random().toString(36).slice(2)}`;
}

beforeEach(async () => {
  await resetRateLimits();
});

describe("rateLimit", () => {
  it("allows attempts up to max and returns ok=true with decreasing remaining", async () => {
    const config = { max: 3, windowMs: 60_000 };
    const key = uniqueKey();
    const r1 = await rateLimit("scope", key, config);
    const r2 = await rateLimit("scope", key, config);
    const r3 = await rateLimit("scope", key, config);

    expect(r1).toEqual({ ok: true, remaining: 2 });
    expect(r2).toEqual({ ok: true, remaining: 1 });
    expect(r3).toEqual({ ok: true, remaining: 0 });
  });

  it("blocks once the counter reaches max and returns retryAfterSec", async () => {
    const config = { max: 2, windowMs: 60_000 };
    const key = uniqueKey();
    await rateLimit("scope", key, config);
    await rateLimit("scope", key, config);
    const blocked = await rateLimit("scope", key, config);

    expect(blocked.ok).toBe(false);
    expect(blocked.remaining).toBe(0);
    expect(blocked.retryAfterSec).toBeGreaterThan(0);
    expect(blocked.retryAfterSec).toBeLessThanOrEqual(60);
  });

  it("resets when the window expires (new bucket, counter=1)", async () => {
    const config = { max: 1, windowMs: 50 };
    const key = uniqueKey();
    const first = await rateLimit("scope", key, config);
    expect(first.ok).toBe(true);
    const blocked = await rateLimit("scope", key, config);
    expect(blocked.ok).toBe(false);

    // Wait out the window — the DB stamps reset_at = now()+50ms, so a short
    // wait lets the next call start a fresh window.
    await new Promise((r) => setTimeout(r, 80));

    const afterWindow = await rateLimit("scope", key, config);
    expect(afterWindow.ok).toBe(true);
    expect(afterWindow.remaining).toBe(0);
  });

  it("keeps different scopes independent", async () => {
    const config = { max: 1, windowMs: 60_000 };
    const key = uniqueKey("shared");
    expect((await rateLimit("login", key, config)).ok).toBe(true);
    expect((await rateLimit("signup", key, config)).ok).toBe(true);
    // Both scopes are at max; second call in either blocks.
    expect((await rateLimit("login", key, config)).ok).toBe(false);
    expect((await rateLimit("signup", key, config)).ok).toBe(false);
  });

  it("keeps different keys within a scope independent", async () => {
    const config = { max: 1, windowMs: 60_000 };
    const keyA = uniqueKey("a");
    const keyB = uniqueKey("b");
    expect((await rateLimit("scope", keyA, config)).ok).toBe(true);
    expect((await rateLimit("scope", keyB, config)).ok).toBe(true);
    expect((await rateLimit("scope", keyA, config)).ok).toBe(false);
    expect((await rateLimit("scope", keyB, config)).ok).toBe(false);
  });

  it("floors retryAfterSec at 1 even when the window has just milliseconds left", async () => {
    const config = { max: 1, windowMs: 100 };
    const key = uniqueKey();
    await rateLimit("scope", key, config);
    const blocked = await rateLimit("scope", key, config);
    expect(blocked.retryAfterSec).toBeGreaterThanOrEqual(1);
  });

  it("does not let the counter grow unbounded once blocked (clamps at max+1)", async () => {
    // A hammered key must keep reporting blocked, but the stored count is clamped
    // so the row can't overflow / drift. We can't read `count` from the public
    // API, but we CAN assert that many over-limit calls all stay blocked and the
    // window doesn't keep getting pushed out by the increments.
    const config = { max: 1, windowMs: 60_000 };
    const key = uniqueKey();
    expect((await rateLimit("scope", key, config)).ok).toBe(true);
    for (let i = 0; i < 20; i++) {
      const r = await rateLimit("scope", key, config);
      expect(r.ok).toBe(false);
      expect(r.retryAfterSec).toBeLessThanOrEqual(60);
    }
  });
});

// The headline guarantee: the limit must hold across SEPARATE process instances
// (Cloud Run runs up to 3 with no session affinity). The old in-memory Map
// multiplied the limit by the instance count and reset on cold start
// (spec-345 perf-3 / spec-349). Here we simulate a second instance by resetting
// the module registry and re-importing — that yields a FRESH module with FRESH
// in-memory state — then prove the counter still blocks because it lives in the
// shared Postgres table, not in the module.
describe("cross-instance (survives a fresh process / module reload)", () => {
  it("a key blocked on 'instance A' is still blocked on a freshly-loaded 'instance B'", async () => {
    const config = { max: 3, windowMs: 60_000 };
    const key = uniqueKey("xinst");

    // ── Instance A: exhaust the limit. ──
    const a = await import("./auth-rate-limit.js");
    await a.resetRateLimits();
    expect((await a.rateLimit("login", key, config)).ok).toBe(true);
    expect((await a.rateLimit("login", key, config)).ok).toBe(true);
    expect((await a.rateLimit("login", key, config)).ok).toBe(true);
    const aBlocked = await a.rateLimit("login", key, config);
    expect(aBlocked.ok).toBe(false); // 4th over a max of 3

    // ── Instance B: a brand-new module load (no shared in-memory state). ──
    vi.resetModules();
    const b = await import("./auth-rate-limit.js");
    // Sanity: it really is a different module object (fresh closure state).
    expect(b).not.toBe(a);
    // Do NOT reset — a real new instance starts cold but the DB row persists.
    const bResult = await b.rateLimit("login", key, config);

    // If the store were process-local, instance B would see count=1 and ALLOW.
    // Backed by Postgres, instance B sees the exhausted window and BLOCKS.
    expect(bResult.ok).toBe(false);
    expect(bResult.retryAfterSec).toBeGreaterThan(0);
  });

  it("two concurrent instances cannot both slip an attempt past max (atomic increment)", async () => {
    // Fire max+5 calls CONCURRENTLY for the same key. A read-modify-write store
    // would lose increments under contention and allow more than `max` through;
    // the single atomic upsert must allow exactly `max`.
    const max = 5;
    const config = { max, windowMs: 60_000 };
    const key = uniqueKey("concurrent");

    const results = await Promise.all(
      Array.from({ length: max + 5 }, () => rateLimit("login", key, config)),
    );
    const allowed = results.filter((r) => r.ok).length;

    expect(allowed).toBe(max);
  });
});

describe("resetRateLimits", () => {
  it("wipes all counters so a previously-blocked key is allowed again", async () => {
    const config = { max: 1, windowMs: 60_000 };
    const key = uniqueKey();
    await rateLimit("scope", key, config);
    expect((await rateLimit("scope", key, config)).ok).toBe(false);
    await resetRateLimits();
    expect((await rateLimit("scope", key, config)).ok).toBe(true);
  });
});

describe("AUTH_LIMITS", () => {
  it("exposes the canonical per-endpoint limits", () => {
    // Guards against silent edits that loosen or tighten production limits without
    // reviewer attention. Any change here is intentional.
    expect(AUTH_LIMITS.signup).toEqual({ max: 5, windowMs: 60 * 60 * 1000 });
    expect(AUTH_LIMITS.login).toEqual({ max: 5, windowMs: 15 * 60 * 1000 });
    expect(AUTH_LIMITS.magicLink).toEqual({ max: 3, windowMs: 60 * 60 * 1000 });
    expect(AUTH_LIMITS.resendVerification).toEqual({
      max: 5,
      windowMs: 60 * 60 * 1000,
    });
    expect(AUTH_LIMITS.resendVerificationCooldown).toEqual({
      max: 1,
      windowMs: 60 * 1000,
    });
    expect(AUTH_LIMITS.passwordReset).toEqual({
      max: 3,
      windowMs: 60 * 60 * 1000,
    });
    expect(AUTH_LIMITS.probe).toEqual({ max: 30, windowMs: 60 * 1000 });
  });
});
