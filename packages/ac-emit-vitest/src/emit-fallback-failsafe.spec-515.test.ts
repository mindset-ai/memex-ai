// spec-515 t-12 / ac-15 — the fail-safe contract survives the t-11 changes.
//
// THE CONTRACT: a failed emission must never fail — or STALL — a consumer's test
// run. Stalling matters as much as throwing, because an awaited flush that overruns
// vitest's `afterAll` budget fails the run just as surely.
//
// WHY THIS TASK EXISTS AS ITS OWN GUARD. t-11 replaced an unbounded
// `Promise.all(bucket.map(emit))` with a bounded worker pool. That fixed
// connection-pool starvation and introduced a NEW failure mode in its place:
// bounding serialises, so total time became LINEAR in the buffer size. Measured
// before the fix below, at 40ms per request with a cap of 4:
//
//     12 events  →  144ms   (12/4 × 40)
//    120 events  → 1240ms   (120/4 × 40)
//
// Extrapolate to a HUNG server, where per-request latency is the 5s AbortSignal
// timeout: 120 events → 120/4 × 5s = 150 SECONDS. The old unbounded fan-out failed
// the same case in ~5s. So t-11, taken alone, converted a fast failure into a
// guaranteed hook-timeout — the one thing the contract forbids. The fix is a total
// deadline on top of the per-request one; these tests pin both halves.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { emitBatch, tagAc } from "./index.js";
import {
  FALLBACK_START_DEADLINE_MS,
  MAX_FALLBACK_CONCURRENCY,
  PER_REQUEST_TIMEOUT_MS,
  runBoundedFallback,
} from "./emit.js";

const AC = "mindset-prod/memex-building-itself/specs/spec-515/acs/ac-15";

const entries = (n: number) =>
  Array.from({ length: n }, (_, i) => ({
    ac_uid: "mindset-prod/foo/specs/spec-1/acs/ac-1",
    status: "pass" as const,
    test_identifier: `test.ts::t${i}`,
    duration_ms: 1,
  }));

/** 404 on /batch so emitBatch degrades to the fallback, then `single` per event. */
const transportWith = (single: () => Promise<unknown> | unknown) =>
  vi.fn(async (url: string) => {
    if (String(url).endsWith("/batch")) {
      return { ok: false, status: 404, headers: new Headers(), text: async () => "" };
    }
    return (await single()) as never;
  });

const slow = (ms: number) => async () => {
  await new Promise((r) => setTimeout(r, ms));
  return { ok: true, status: 201, headers: new Headers(), text: async () => "" };
};

beforeEach(() => {
  for (const k of ["MEMEX_EMIT", "MEMEX_EMIT_KEY", "MEMEX_TEST_EVENTS_URL"]) {
    vi.stubEnv(k, "");
  }
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  // std-37 cl-5 — a leaked global stub can silently swallow AC emission elsewhere.
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("fallback total deadline (spec-515 ac-15)", () => {
  it("stops issuing requests once the deadline is spent", async () => {
    // The regression this guards: without a total deadline, 200 slow events would
    // all be attempted, 4 at a time, however long that takes.
    tagAc(AC);
    const transport = transportWith(slow(20));
    await runBoundedFallback(entries(200), transport as unknown as typeof fetch, 120);
    // 120ms of budget at 20ms per request, 4 in flight ≈ 24 requests. Assert it
    // stopped WELL short of 200 rather than pinning a brittle exact count.
    const singles = transport.mock.calls.filter(([u]) => !String(u).endsWith("/batch"));
    expect(singles.length).toBeLessThan(60);
    expect(singles.length).toBeGreaterThan(0);
  });

  it("keeps a hung server inside vitest's afterAll budget", async () => {
    // The arithmetic that matters, asserted on the constants rather than by waiting
    // 10s: the deadline bounds when the LAST request may START, and each request is
    // itself bounded, so worst-case total ≤ deadline + per-request timeout. That has
    // to leave room inside vitest's 10s default hookTimeout for everything else in
    // afterAll.
    tagAc(AC);
    expect(FALLBACK_START_DEADLINE_MS + PER_REQUEST_TIMEOUT_MS).toBeLessThan(10_000);
    // And it must be generous enough that a healthy-but-slow server still lands a
    // realistic file's worth of events: ~4 × deadline/200ms at 200ms per request.
    expect(FALLBACK_START_DEADLINE_MS).toBeGreaterThanOrEqual(3_000);
  });

  it("a large buffer against a healthy server still completes promptly", async () => {
    tagAc(AC);
    const transport = transportWith(slow(2));
    const t0 = Date.now();
    await runBoundedFallback(entries(120), transport as unknown as typeof fetch);
    expect(Date.now() - t0).toBeLessThan(FALLBACK_START_DEADLINE_MS);
  });
});

describe("fail-safe: every failure mode leaves the run green (spec-515 ac-15)", () => {
  const modes: Array<[string, () => Promise<unknown> | unknown]> = [
    ["401 — auth refused mid-flush", () => ({ ok: false, status: 401, headers: new Headers(), text: async () => "expired" })],
    ["500 — transient, per-event", () => ({ ok: false, status: 500, headers: new Headers(), text: async () => "boom" })],
    ["network error", () => { throw new Error("ECONNREFUSED"); }],
    ["a body that cannot be read", () => ({ ok: false, status: 400, headers: new Headers(), text: async () => { throw new Error("unreadable"); } })],
    ["a response with no headers object", () => ({ ok: true, status: 201, text: async () => "" })],
  ];

  for (const [label, single] of modes) {
    it(`resolves, never throws: ${label}`, async () => {
      tagAc(AC);
      await expect(
        emitBatch(entries(9), transportWith(single) as unknown as typeof fetch),
      ).resolves.toBeUndefined();
    });
  }

  it("resolves when the whole transport rejects (no /batch, no anything)", async () => {
    tagAc(AC);
    const transport = vi.fn(async () => {
      throw new Error("host unreachable");
    });
    await expect(
      emitBatch(entries(5), transport as unknown as typeof fetch),
    ).resolves.toBeUndefined();
  });

  it("honours the off switch even with a full buffer — zero requests", async () => {
    tagAc(AC);
    vi.stubEnv("MEMEX_EMIT", "false");
    const transport = transportWith(slow(0));
    await emitBatch(entries(30), transport as unknown as typeof fetch);
    expect(transport).not.toHaveBeenCalled();
  });

  it("a server with no /batch route still lands every event (std-22 self-hosted)", async () => {
    // The fallback is a deliberate portability feature, not a bug path. Bounding and
    // deadlining it must not turn "slower" into "lossy" for a healthy old server.
    tagAc(AC);
    const transport = transportWith(slow(0));
    await emitBatch(entries(25), transport as unknown as typeof fetch);
    const singles = transport.mock.calls.filter(([u]) => !String(u).endsWith("/batch"));
    expect(singles).toHaveLength(25);
  });

  it("never exceeds the concurrency cap while honouring the deadline", async () => {
    tagAc(AC);
    let now = 0;
    let peak = 0;
    const transport = transportWith(async () => {
      now += 1;
      peak = Math.max(peak, now);
      await Promise.resolve();
      await Promise.resolve();
      now -= 1;
      return { ok: true, status: 201, headers: new Headers(), text: async () => "" };
    });
    await emitBatch(entries(50), transport as unknown as typeof fetch);
    expect(peak).toBeLessThanOrEqual(MAX_FALLBACK_CONCURRENCY);
  });
});
