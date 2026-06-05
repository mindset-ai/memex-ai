import { describe, it, expect, beforeEach } from "vitest";
import {
  rateLimit,
  resetRateLimits,
  AUTH_LIMITS,
} from "./auth-rate-limit.js";

// Unit coverage for the sliding-window rate limiter. Pure in-memory — no DB, no network.
// Each test resets global buckets so ordering doesn't matter.

beforeEach(() => resetRateLimits());

describe("rateLimit", () => {
  it("allows attempts up to max and returns ok=true with decreasing remaining", () => {
    const config = { max: 3, windowMs: 60_000 };
    const r1 = rateLimit("scope", "key", config);
    const r2 = rateLimit("scope", "key", config);
    const r3 = rateLimit("scope", "key", config);

    expect(r1).toEqual({ ok: true, remaining: 2 });
    expect(r2).toEqual({ ok: true, remaining: 1 });
    expect(r3).toEqual({ ok: true, remaining: 0 });
  });

  it("blocks once the counter reaches max and returns retryAfterSec", () => {
    const config = { max: 2, windowMs: 60_000 };
    rateLimit("scope", "key", config);
    rateLimit("scope", "key", config);
    const blocked = rateLimit("scope", "key", config);

    expect(blocked.ok).toBe(false);
    expect(blocked.remaining).toBe(0);
    expect(blocked.retryAfterSec).toBeGreaterThan(0);
    expect(blocked.retryAfterSec).toBeLessThanOrEqual(60);
  });

  it("resets when the window expires (new bucket, counter=1)", async () => {
    const config = { max: 1, windowMs: 20 };
    const first = rateLimit("scope", "key", config);
    expect(first.ok).toBe(true);
    const blocked = rateLimit("scope", "key", config);
    expect(blocked.ok).toBe(false);

    // Wait out the window — the 20ms bound keeps this fast but deterministic.
    await new Promise((r) => setTimeout(r, 30));

    const afterWindow = rateLimit("scope", "key", config);
    expect(afterWindow.ok).toBe(true);
    expect(afterWindow.remaining).toBe(0);
  });

  it("keeps different scopes independent", () => {
    const config = { max: 1, windowMs: 60_000 };
    expect(rateLimit("login", "same-key", config).ok).toBe(true);
    expect(rateLimit("signup", "same-key", config).ok).toBe(true);
    // Both scopes are at max; third call in either blocks.
    expect(rateLimit("login", "same-key", config).ok).toBe(false);
    expect(rateLimit("signup", "same-key", config).ok).toBe(false);
  });

  it("keeps different keys within a scope independent", () => {
    const config = { max: 1, windowMs: 60_000 };
    expect(rateLimit("scope", "key-a", config).ok).toBe(true);
    expect(rateLimit("scope", "key-b", config).ok).toBe(true);
    expect(rateLimit("scope", "key-a", config).ok).toBe(false);
    expect(rateLimit("scope", "key-b", config).ok).toBe(false);
  });

  it("floors retryAfterSec at 1 even when the window has just milliseconds left", () => {
    // Hit the limiter, then manipulate nothing — the first block should have retryAfterSec
    // rounded up via Math.ceil; assert it's never <1 so the client's 'Retry-After: 0' bug
    // class is impossible.
    const config = { max: 1, windowMs: 100 };
    rateLimit("scope", "key", config);
    const blocked = rateLimit("scope", "key", config);
    expect(blocked.retryAfterSec).toBeGreaterThanOrEqual(1);
  });
});

describe("resetRateLimits", () => {
  it("wipes all counters so a previously-blocked key is allowed again", () => {
    const config = { max: 1, windowMs: 60_000 };
    rateLimit("scope", "key", config);
    expect(rateLimit("scope", "key", config).ok).toBe(false);
    resetRateLimits();
    expect(rateLimit("scope", "key", config).ok).toBe(true);
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
    expect(AUTH_LIMITS.passwordReset).toEqual({
      max: 3,
      windowMs: 60 * 60 * 1000,
    });
    expect(AUTH_LIMITS.probe).toEqual({ max: 30, windowMs: 60 * 1000 });
  });
});
