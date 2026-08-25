// spec-522 t-2 / t-5 — the shared query vector: cached, bounded, and bounded in
// time. Pure unit tests; no DB, no network.
//
// WHY A CLASS WITH INJECTED cap/ttl/now RATHER THAN A RESET HATCH. Eviction and
// expiry are the two behaviours most likely to be quietly wrong, and both are
// untestable against a module singleton without either sleeping for real or
// exporting a reset that production code could then call — which would let
// someone discard the very connection-reused vectors the cache exists to keep.
// Injecting a clock and a cap tests the real code path deterministically.

import { describe, it, expect, vi } from "vitest";
import { tagAc } from "@memex-ai-ac/vitest";
import {
  QueryVectorCache,
  resolveQueryVector,
  resolveEmbedTimeoutMs,
} from "./query-vector.js";
import type { EmbeddingProvider } from "../embedding-provider.js";

const AC = (n: number) =>
  `mindset-prod/memex-building-itself/specs/spec-522/acs/ac-${n}`;

/** Counts calls so "exactly one round-trip" is observable, and lets each test
 *  choose how the provider behaves (fast, slow, throwing). */
function fakeProvider(
  opts: {
    name?: string;
    vector?: number[];
    delayMs?: number;
    throws?: boolean;
  } = {},
): EmbeddingProvider & { callCount: number } {
  const provider = {
    name: opts.name ?? "fake-1536",
    dim: 1536,
    maxBatchSize: 96,
    callCount: 0,
    async embed(texts: string[]): Promise<number[][]> {
      provider.callCount += 1;
      if (opts.throws) throw new Error("provider exploded");
      if (opts.delayMs) {
        await new Promise((r) => setTimeout(r, opts.delayMs));
      }
      return texts.map(() => opts.vector ?? [1, 2, 3]);
    },
  };
  return provider;
}

describe("QueryVectorCache — bounded and TTL'd (ac-12)", () => {
  it("evicts the least-recently-used entry once the cap is exceeded", () => {
    tagAc(AC(12));
    const cache = new QueryVectorCache({ maxEntries: 3, ttlMs: 60_000 });

    cache.set("m", "a", [1]);
    cache.set("m", "b", [2]);
    cache.set("m", "c", [3]);
    expect(cache.size).toBe(3);

    // Touch "a" so it is the most-recently-used, NOT the oldest by insertion.
    expect(cache.get("m", "a")).toEqual([1]);

    cache.set("m", "d", [4]);

    // Still capped, and it shed "b" (least recently used) rather than "a"
    // (oldest inserted). A plain FIFO would have dropped the hot entry.
    expect(cache.size).toBe(3);
    expect(cache.get("m", "a")).toEqual([1]);
    expect(cache.get("m", "b")).toBeUndefined();
    expect(cache.get("m", "c")).toEqual([3]);
    expect(cache.get("m", "d")).toEqual([4]);
  });

  it("stays within its cap under a flood of distinct queries", () => {
    tagAc(AC(12));
    const cache = new QueryVectorCache({ maxEntries: 10, ttlMs: 60_000 });
    for (let i = 0; i < 500; i++) cache.set("m", `query-${i}`, [i]);
    expect(cache.size).toBe(10);
  });

  it("expires entries past the TTL rather than serving them forever", () => {
    tagAc(AC(12));
    let clock = 1_000;
    const cache = new QueryVectorCache({
      maxEntries: 100,
      ttlMs: 5_000,
      now: () => clock,
    });

    cache.set("m", "a", [1]);
    clock += 4_999;
    expect(cache.get("m", "a")).toEqual([1]);

    clock += 2; // now past expiry
    expect(cache.get("m", "a")).toBeUndefined();
    // Expiry also reclaims the slot rather than leaking a dead entry.
    expect(cache.size).toBe(0);
  });
});

describe("resolveQueryVector — one round-trip per distinct (query, model) (ac-11)", () => {
  it("a repeated identical query issues ZERO further embed calls", async () => {
    tagAc(AC(11));
    const cache = new QueryVectorCache();
    const provider = fakeProvider();

    const first = await resolveQueryVector(provider, "cache me", cache);
    const second = await resolveQueryVector(provider, "cache me", cache);
    const third = await resolveQueryVector(provider, "cache me", cache);

    expect(provider.callCount).toBe(1);
    expect(first).toEqual({ vector: [1, 2, 3], model: "fake-1536" });
    expect(second).toEqual(first);
    expect(third).toEqual(first);
  });

  it("a different query under the same model is a miss", async () => {
    tagAc(AC(11));
    const cache = new QueryVectorCache();
    const provider = fakeProvider();

    await resolveQueryVector(provider, "one", cache);
    await resolveQueryVector(provider, "two", cache);

    expect(provider.callCount).toBe(2);
  });

  it("never serves a vector produced by a DIFFERENT provider", async () => {
    tagAc(AC(11));
    // This is the correctness case, not a nicety: every vector arm filters
    // `embedding_model = <model>`, so serving an OpenAI vector while claiming the
    // Cohere model would query the wrong population and silently return garbage.
    const cache = new QueryVectorCache();
    const openai = fakeProvider({ name: "openai-1536", vector: [1, 1, 1] });
    const cohere = fakeProvider({ name: "cohere-1536", vector: [9, 9, 9] });

    const a = await resolveQueryVector(openai, "same string", cache);
    const b = await resolveQueryVector(cohere, "same string", cache);

    expect(openai.callCount).toBe(1);
    expect(cohere.callCount).toBe(1);
    expect(a).toEqual({ vector: [1, 1, 1], model: "openai-1536" });
    expect(b).toEqual({ vector: [9, 9, 9], model: "cohere-1536" });
  });

  it("returns null with no provider, and does not cache the absence", async () => {
    tagAc(AC(11));
    const cache = new QueryVectorCache();
    expect(await resolveQueryVector(null, "anything", cache)).toBeNull();
    expect(cache.size).toBe(0);
  });
});

describe("resolveQueryVector — degradation (ac-15)", () => {
  it("a provider that throws yields null rather than propagating", async () => {
    tagAc(AC(15));
    const cache = new QueryVectorCache();
    const provider = fakeProvider({ throws: true });

    await expect(
      resolveQueryVector(provider, "boom", cache),
    ).resolves.toBeNull();
    // A failure must not be cached — the next search should retry, not inherit
    // the outage for the rest of the TTL window.
    expect(cache.size).toBe(0);
  });

  it("a hanging provider is abandoned at the timeout instead of blocking the search", async () => {
    tagAc(AC(15));
    const cache = new QueryVectorCache();
    // 50 ms of "work" against a 10 ms ceiling: the call has NOT failed, it is
    // merely slow — which is exactly the case that had no handling before.
    const provider = fakeProvider({ delayMs: 50 });

    const started = Date.now();
    const result = await resolveQueryVector(provider, "slow", cache, 10);
    const elapsed = Date.now() - started;

    expect(result).toBeNull();
    // Generous upper bound: the point is that it returned on the timeout rather
    // than waiting out the full 50 ms, not that timers are precise.
    expect(elapsed).toBeLessThan(45);
    expect(cache.size).toBe(0);
  });

  it("a provider that answers inside the ceiling is unaffected", async () => {
    tagAc(AC(15));
    const cache = new QueryVectorCache();
    const provider = fakeProvider({ delayMs: 5 });

    const result = await resolveQueryVector(provider, "quick", cache, 1_000);

    expect(result).toEqual({ vector: [1, 2, 3], model: "fake-1536" });
    expect(cache.size).toBe(1);
  });

  it("does not leave a pending timer holding the event loop open", async () => {
    tagAc(AC(15));
    // Regression guard for a real hazard: without clearTimeout in the `finally`,
    // every fast success leaves a live 3s timer, and a suite that should exit
    // immediately instead hangs until the last one fires.
    const clearSpy = vi.spyOn(globalThis, "clearTimeout");
    const cache = new QueryVectorCache();

    await resolveQueryVector(fakeProvider(), "tidy", cache, 1_000);

    expect(clearSpy).toHaveBeenCalled();
    clearSpy.mockRestore();
  });
});

describe("resolveEmbedTimeoutMs", () => {
  it("prefers an explicit value, then the env var, then the default", () => {
    const saved = process.env.MEMEX_SEARCH_EMBED_TIMEOUT_MS;
    try {
      delete process.env.MEMEX_SEARCH_EMBED_TIMEOUT_MS;
      expect(resolveEmbedTimeoutMs()).toBe(3_000);

      process.env.MEMEX_SEARCH_EMBED_TIMEOUT_MS = "1234";
      expect(resolveEmbedTimeoutMs()).toBe(1234);
      expect(resolveEmbedTimeoutMs(50)).toBe(50);

      // Junk and non-positive values fall back rather than disabling the ceiling.
      process.env.MEMEX_SEARCH_EMBED_TIMEOUT_MS = "not-a-number";
      expect(resolveEmbedTimeoutMs()).toBe(3_000);
      process.env.MEMEX_SEARCH_EMBED_TIMEOUT_MS = "0";
      expect(resolveEmbedTimeoutMs()).toBe(3_000);
    } finally {
      if (saved === undefined) delete process.env.MEMEX_SEARCH_EMBED_TIMEOUT_MS;
      else process.env.MEMEX_SEARCH_EMBED_TIMEOUT_MS = saved;
    }
  });
});
