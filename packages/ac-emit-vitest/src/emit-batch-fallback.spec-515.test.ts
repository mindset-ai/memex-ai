// spec-515 t-11 / ac-13, ac-14 — the 404 fallback must be bounded and must give up
// once auth is definitively refused.
//
// WHAT THE FALLBACK IS FOR. A server with no `/batch` route (an older deploy, or a
// self-hosted install on a prior version — std-22 portability) answers 404/405, and
// emitBatch degrades to one POST per event so emissions still land. That path is
// deliberate and permanent; spec-515 only makes it rare against Memex's own hosts.
//
// WHAT WAS WRONG WITH IT. `await Promise.all(bucket.map(emit))` released EVERY
// buffered event of a file simultaneously, and vitest runs files across parallel
// workers, so in-flight requests were (events per file) × (workers), uncapped.
// Measured consequence on prod 2026-07-24: ~1,800 single POSTs/min. The sharpest
// risk is not DB CPU but CONNECTION-POOL STARVATION — prod's budget is 8 instances
// × (DB_POOL_MAX 4 + 1 relay LISTEN) = 40 slots total (spec-518; this comment used
// to cite a `DB_POOL_MAX=10 × maxScale 3 = 30` shape that was never deployed),
// against which one 50-test file across 7 workers can put ~350 concurrent requests,
// queueing CI traffic ahead of real users. Verbatim what spec-489 ac-3 set out to
// prevent.
//
// AND: a 401 on the first fallback POST guarantees the rest will also 401 — same
// key, same server — but they were already in flight, and nothing watched the first
// failure to stop the others. Measured: 1,347 rejections in 3 minutes (2026-07-26),
// which were 1,347 DISTINCT events failing once each. There is no retry in this
// emitter; the volume came from the fan-out.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { emitBatch, tagAc } from "./index.js";
import { MAX_FALLBACK_CONCURRENCY } from "./emit.js";

const AC_BOUNDED = "mindset-prod/memex-building-itself/specs/spec-515/acs/ac-13";
const AC_SHORTCIRCUIT = "mindset-prod/memex-building-itself/specs/spec-515/acs/ac-14";

const entries = (n: number) =>
  Array.from({ length: n }, (_, i) => ({
    ac_uid: "mindset-prod/foo/specs/spec-1/acs/ac-1",
    status: "pass" as const,
    test_identifier: `test.ts::t${i}`,
    duration_ms: 1,
  }));

/** 404 on /batch, then a caller-supplied response for each single-event POST. */
function transportWith(single: () => Promise<unknown> | unknown) {
  const inFlight = { now: 0, peak: 0 };
  const singleCalls: string[] = [];
  const fetchMock = vi.fn(async (url: string) => {
    if (String(url).endsWith("/batch")) {
      return { ok: false, status: 404, headers: new Headers(), text: async () => "" };
    }
    singleCalls.push(String(url));
    inFlight.now += 1;
    inFlight.peak = Math.max(inFlight.peak, inFlight.now);
    try {
      // Yield twice so genuinely-parallel calls overlap and `peak` is meaningful;
      // a single microtask would let each call finish before the next begins and
      // the assertion would pass even with an unbounded fan-out.
      await Promise.resolve();
      await Promise.resolve();
      return (await single()) as never;
    } finally {
      inFlight.now -= 1;
    }
  });
  return { fetchMock, inFlight, singleCalls };
}

const ok = () => ({ ok: true, status: 201, headers: new Headers(), text: async () => "" });
const unauthorized = () => ({
  ok: false,
  status: 401,
  headers: new Headers(),
  text: async () => '{"error":"emission key expired"}',
});

beforeEach(() => {
  for (const k of [
    "MEMEX_EMIT",
    "MEMEX_EMIT_KEY",
    "MEMEX_TEST_EVENTS_URL",
    "GITHUB_ACTOR",
    "GITLAB_USER_LOGIN",
    "BUILDKITE_BUILD_AUTHOR",
    "CIRCLE_USERNAME",
    "USER",
    "USERNAME",
  ]) {
    vi.stubEnv(k, "");
  }
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  // std-37 cl-5: a leaked global stub can silently swallow AC emission elsewhere.
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("emitBatch 404 fallback — bounded concurrency (spec-515 ac-13)", () => {
  it("never holds more than the cap in flight, however many events buffered", async () => {
    tagAc(AC_BOUNDED);
    const { fetchMock, inFlight, singleCalls } = transportWith(ok);
    await emitBatch(entries(40), fetchMock as unknown as typeof fetch);

    // Every event still lands — bounding must not drop emissions.
    expect(singleCalls).toHaveLength(40);
    expect(inFlight.peak).toBeLessThanOrEqual(MAX_FALLBACK_CONCURRENCY);
  });

  it("actually parallelises up to the cap — not accidentally serial", async () => {
    // A cap of 1 would also satisfy the assertion above while making a 500-event
    // flush crawl and risk overrunning vitest's afterAll budget. Pin that the
    // fallback genuinely uses its allowance.
    tagAc(AC_BOUNDED);
    const { fetchMock, inFlight } = transportWith(ok);
    await emitBatch(entries(40), fetchMock as unknown as typeof fetch);
    expect(inFlight.peak).toBeGreaterThan(1);
  });

  it("the cap is small enough to respect the server's connection pool", async () => {
    // Prod's budget is 8 instances × (DB_POOL_MAX 4 + 1 relay LISTEN) = 40 slots,
    // shared with real user traffic. The cap is per flush and several vitest workers
    // can flush together, so it has to leave headroom rather than merely be finite.
    tagAc(AC_BOUNDED);
    expect(MAX_FALLBACK_CONCURRENCY).toBeLessThanOrEqual(5);
    expect(MAX_FALLBACK_CONCURRENCY).toBeGreaterThanOrEqual(2);
  });
});

describe("emitBatch 404 fallback — 401 short-circuit (spec-515 ac-14)", () => {
  it("abandons the remaining events once a 401 comes back", async () => {
    tagAc(AC_SHORTCIRCUIT);
    const { fetchMock, singleCalls } = transportWith(unauthorized);
    await emitBatch(entries(40), fetchMock as unknown as typeof fetch);

    // An invalid key costs one rejected request per flush, not one per event. The
    // in-flight batch cannot be recalled, so the bound is the cap — decisively
    // fewer than 40, which is what turned 1,347 rejections into a handful.
    expect(singleCalls.length).toBeLessThanOrEqual(MAX_FALLBACK_CONCURRENCY);
    expect(singleCalls.length).toBeGreaterThan(0);
  });

  it("does NOT short-circuit on an ordinary non-2xx — only on refused auth", async () => {
    // A 500 is transient and per-event; abandoning the flush would silently lose
    // emissions the server might well have accepted. Only 401 is definitive.
    tagAc(AC_SHORTCIRCUIT);
    const { fetchMock, singleCalls } = transportWith(() => ({
      ok: false,
      status: 500,
      headers: new Headers(),
      text: async () => "boom",
    }));
    await emitBatch(entries(12), fetchMock as unknown as typeof fetch);
    expect(singleCalls).toHaveLength(12);
  });

  it("does not throw when auth is refused mid-flush (fail-safe holds)", async () => {
    tagAc(AC_SHORTCIRCUIT);
    const { fetchMock } = transportWith(unauthorized);
    await expect(
      emitBatch(entries(20), fetchMock as unknown as typeof fetch),
    ).resolves.toBeUndefined();
  });
});
