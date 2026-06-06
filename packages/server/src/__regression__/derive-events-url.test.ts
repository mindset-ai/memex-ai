// b-90 — behavioural test for the helper's deriveEventsUrl function.
//
// Covers the runtime contract for the URL derivation:
//   ac-2: unknown namespace + no override → default to the SaaS host (memex.ai)
//   ac-3: override conflicts with known namespace map → loud conflict warn
//   ac-4: first emission per (namespace, destination) → routing log
//   ac-12: conflict warn fires at most once per (namespace, override) tuple
//   ac-13: different (namespace, override) tuples each fire their own warn
//
// The dedupe Sets are module-level so test order matters; each test uses
// distinct namespace + URL strings to avoid collision.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { deriveEventsUrl, tagAc } from "@memex-ai-ac/vitest";

let warnSpy: ReturnType<typeof vi.spyOn>;
let priorEnv: string | undefined;

beforeEach(() => {
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  priorEnv = process.env.MEMEX_TEST_EVENTS_URL;
  delete process.env.MEMEX_TEST_EVENTS_URL;
});

afterEach(() => {
  warnSpy.mockRestore();
  if (priorEnv === undefined) {
    delete process.env.MEMEX_TEST_EVENTS_URL;
  } else {
    process.env.MEMEX_TEST_EVENTS_URL = priorEnv;
  }
});

describe("spec-90 ac-2: unknown namespace defaults to the SaaS host (memex.ai)", () => {
  it("returns the memex.ai destination for an unknown namespace with no override", () => {
    tagAc("mindset-prod/memex-building-itself/specs/spec-90/acs/ac-2");
    // ac-15 (customer outcome): the client half — a tenant's own-namespace ref
    // routes to the SaaS host with zero config / no override.
    tagAc("mindset-prod/memex-building-itself/specs/spec-90/acs/ac-15");
    // A namespace not in NAMESPACE_TO_BASE_URL: a customer tenant. dec-7/B1 —
    // memex.ai serves every tenant, so it routes there rather than skipping.
    const url = deriveEventsUrl("b90-ac2-customer-ns/whatever/specs/spec-1/acs/ac-1");
    expect(url).toBe("https://memex.ai/api/test-events");
  });

  it("never falls through to localhost for an unknown namespace", () => {
    tagAc("mindset-prod/memex-building-itself/specs/spec-90/acs/ac-2");
    const url = deriveEventsUrl("b90-ac2-no-localhost-ns/whatever/specs/spec-1/acs/ac-1");
    // The enduring half of b-90: localhost is never a default destination.
    expect(url).not.toMatch(/localhost/);
    expect(url).toBe("https://memex.ai/api/test-events");
  });

  it("returns null only for a malformed ref with no namespace", () => {
    tagAc("mindset-prod/memex-building-itself/specs/spec-90/acs/ac-2");
    expect(deriveEventsUrl("")).toBeNull();
  });
});

describe("b-90 ac-3: conflict warn when override contradicts known namespace map", () => {
  it("fires a loud warning naming both the override URL and the canonical destination", () => {
    tagAc("mindset-prod/memex-building-itself/specs/spec-90/acs/ac-3");
    process.env.MEMEX_TEST_EVENTS_URL = "http://localhost:18001/api/test-events";
    const url = deriveEventsUrl("mindset-prod/x/briefs/b-1/acs/ac-1");
    // Helper still emits to the override (that's the user's deliberate choice).
    expect(url).toBe("http://localhost:18001/api/test-events");
    // But the warning surfaced the conflict.
    const warnArgs = warnSpy.mock.calls.flat().join(" ");
    expect(warnArgs).toMatch(/overriding the default route/i);
    expect(warnArgs).toMatch(/mindset-prod/);
    expect(warnArgs).toMatch(/https:\/\/memex\.ai\/api\/test-events/);
    expect(warnArgs).toMatch(/http:\/\/localhost:18001\/api\/test-events/);
  });

  it("does NOT warn when the override matches the canonical destination", () => {
    tagAc("mindset-prod/memex-building-itself/specs/spec-90/acs/ac-3");
    process.env.MEMEX_TEST_EVENTS_URL = "https://int.memex.ai/api/test-events";
    deriveEventsUrl("mindset-int/x/briefs/b-1/acs/ac-1");
    const warnArgs = warnSpy.mock.calls.flat().join(" ");
    expect(warnArgs).not.toMatch(/overriding the default route/i);
  });
});

describe("b-90 ac-4: routing log fires on first emission per (namespace, destination) tuple", () => {
  it("logs a single `routing namespace=X → URL` line on the first call", () => {
    tagAc("mindset-prod/memex-building-itself/specs/spec-90/acs/ac-4");
    // Use a fresh namespace + override-URL tuple that no prior test in this
    // file has touched, so the routedTuples Set hasn't seen it.
    process.env.MEMEX_TEST_EVENTS_URL = "https://b90-ac4-routing-log.example/api/test-events";
    deriveEventsUrl("b90-ac4-routing-log-ns/b90-ac4-first/briefs/b-1/acs/ac-1");
    const calls = warnSpy.mock.calls.map((c: unknown[]) => c.join(" "));
    const routingLines = calls.filter(
      (s: string) => /routing namespace=/i.test(s) && /b90-ac4-routing-log/.test(s),
    );
    expect(routingLines.length).toBeGreaterThan(0);
    expect(routingLines[0]).toMatch(/b90-ac4-routing-log-ns/);
    expect(routingLines[0]).toMatch(/b90-ac4-routing-log\.example/);
  });
});

describe("b-90 ac-12: conflict warn fires at most once per (namespace, override-url) tuple", () => {
  it("first emission warns; second emission with the same tuple does NOT re-warn", () => {
    tagAc("mindset-prod/memex-building-itself/specs/spec-90/acs/ac-12");
    process.env.MEMEX_TEST_EVENTS_URL = "http://localhost:18012/api/test-events";

    // Use a fresh namespace not touched by other tests so the conflictWarnedFor
    // Set is empty for this (namespace, override-url) tuple.
    // dec-1 of the test is a mindset-prod-shaped namespace whose conflict
    // warn fired in ac-3's test, but we're using a DIFFERENT override URL
    // here so the tuple is fresh.
    const calls1 = warnSpy.mock.calls.length;
    deriveEventsUrl("mindset-prod/b90-ac12/briefs/b-1/acs/ac-1");
    const conflictsAfter1 = warnSpy.mock.calls
      .map((c: unknown[]) => c.join(" "))
      .filter((s: string) => /overriding the default route/i.test(s) && /b90-ac12/.test(s)).length;
    // Hmm — the warn is keyed on (namespace, url) not (ac_uid). Use a fresh
    // namespace + override-url combo unique to this test.
    expect(conflictsAfter1).toBeGreaterThanOrEqual(0); // sanity

    void calls1;
    // Now use a clearly-fresh namespace key.
    process.env.MEMEX_TEST_EVENTS_URL = "http://localhost:18999/api/test-events";
    // For dedupe purposes we need to make sure the namespace + override
    // combination hasn't been seen. mindset-prod has been seen with other
    // override URLs already — but the dedupe is per (namespace, override-url)
    // tuple, so localhost:18999 is fresh.
    deriveEventsUrl("mindset-prod/b90-ac12-fresh/briefs/b-1/acs/ac-1");
    const firstWarnCount = warnSpy.mock.calls
      .map((c: unknown[]) => c.join(" "))
      .filter((s: string) => /overriding the default route/i.test(s) && /localhost:18999/.test(s))
      .length;

    deriveEventsUrl("mindset-prod/b90-ac12-fresh2/briefs/b-1/acs/ac-1");
    const secondWarnCount = warnSpy.mock.calls
      .map((c: unknown[]) => c.join(" "))
      .filter((s: string) => /overriding the default route/i.test(s) && /localhost:18999/.test(s))
      .length;

    // Both calls share the (mindset-prod, localhost:18999) tuple; the second
    // must NOT have produced an additional warn.
    expect(firstWarnCount).toBe(1);
    expect(secondWarnCount).toBe(1);
  });
});

describe("b-90 ac-13: different (namespace, override-url) tuples each fire their own first-time warn", () => {
  it("two distinct override URLs against the same namespace each produce a separate warn", () => {
    tagAc("mindset-prod/memex-building-itself/specs/spec-90/acs/ac-13");

    process.env.MEMEX_TEST_EVENTS_URL = "http://localhost:18013/api/test-events";
    deriveEventsUrl("mindset-prod/b90-ac13-a/briefs/b-1/acs/ac-1");

    process.env.MEMEX_TEST_EVENTS_URL = "http://localhost:18014/api/test-events";
    deriveEventsUrl("mindset-prod/b90-ac13-b/briefs/b-1/acs/ac-1");

    const calls = warnSpy.mock.calls.map((c: unknown[]) => c.join(" "));
    const warn18013 = calls.filter((s: string) => /overriding the default route/i.test(s) && /localhost:18013/.test(s));
    const warn18014 = calls.filter((s: string) => /overriding the default route/i.test(s) && /localhost:18014/.test(s));

    // Each distinct override-url against mindset-prod must have produced its
    // own first-time warn. The dedupe is per-tuple, not global.
    expect(warn18013.length).toBe(1);
    expect(warn18014.length).toBe(1);
  });
});
