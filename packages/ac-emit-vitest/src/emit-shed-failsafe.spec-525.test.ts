// spec-525 t-7 / ac-3 — no client breaks when the server sheds, at any version.
//
// The fail-safe contract is what makes shedding acceptable at all. spec-525 refuses
// emissions under load on the assumption that a refused client warns and moves on; if
// that assumption is wrong the Spec does harm instead of good. So it is proven here
// rather than assumed — and this Spec has already had one claim survive a careful
// reading of the source and then die on measurement (spec-528 issue-1).
//
// THE AMPLIFICATION THIS FORBIDS. `emitBatch` degrades to one POST per event when the
// batch route is ABSENT (404/405). If a 429 were to take that branch, one shed batch
// would become up to MAX_BATCH_EVENTS = 500 single POSTs at the exact moment the
// instance is saturated — the gate's own mechanism turned into a flood. That inverts
// the entire design, so the test counts single-event POSTs and asserts ZERO. Reading
// the `404 || 405` condition is not the proof; a future widening of it is exactly what
// this catches.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { emitBatch, emit, tagAc } from "./index.js";

const AC_NO_BREAK = "mindset-prod/memex-building-itself/specs/spec-525/acs/ac-3";

const entries = (n: number) =>
  Array.from({ length: n }, (_, i) => ({
    ac_uid: "mindset-prod/foo/specs/spec-1/acs/ac-1",
    status: "pass" as const,
    test_identifier: `shed.test.ts::t${i}`,
    duration_ms: 1,
  }));

/** The response a shedding gate returns. */
const shed = () => ({
  ok: false,
  status: 429,
  headers: new Headers(),
  text: async () =>
    '{"error":"too_many_requests","message":"Emission ingest is shedding load"}',
});

/** Counts what the client actually sent, split by endpoint. */
function countingTransport(respond: () => unknown) {
  const batchCalls: string[] = [];
  const singleCalls: string[] = [];
  const fetchMock = vi.fn(async (url: string) => {
    if (String(url).endsWith("/batch")) batchCalls.push(String(url));
    else singleCalls.push(String(url));
    return respond() as never;
  });
  return { fetchMock, batchCalls, singleCalls };
}

let warnings: string[] = [];
let warnSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  // Neutralise the ambient environment, exactly as spec-515's sibling suite does.
  // MEMEX_EMIT is the one that matters here and it is easy to miss: the off-switch
  // makes the emitter issue ZERO requests, so a run with `MEMEX_EMIT=false` reds every
  // assertion below for a reason that has nothing to do with shedding. Caught during
  // t-7 when the repo-wide suite run exported it; the same trap reds
  // packages/ui e2e-ac-emission.spec-391.test.ts, and its message never names the flag.
  for (const k of [
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
  // Explicitly ON, so the suite tests the emitter rather than the ambient config.
  vi.stubEnv("MEMEX_EMIT", "true");

  warnings = [];
  warnSpy = vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
    warnings.push(args.map(String).join(" "));
  });
});

afterEach(() => {
  // [per std-37] cl-5: restore what the test replaced, or a leaked global swallows a
  // sibling's output — and console is the one this file depends on observing.
  warnSpy.mockRestore();
  vi.unstubAllEnvs();
});

describe("spec-525 ac-3: a 429 on /batch is absorbed, and does NOT amplify", () => {
  it("sends ONE batch request and ZERO single-event POSTs — no per-event fallback", async () => {
    tagAc(AC_NO_BREAK);
    const { fetchMock, batchCalls, singleCalls } = countingTransport(shed);

    await emitBatch(entries(200), fetchMock as unknown as typeof fetch);

    expect(batchCalls).toHaveLength(1);
    // THE assertion. 200 events refused must cost 200 events, not 200 requests.
    // A widened 404/405 condition would show up right here as 200 single POSTs
    // against a server that just said it was saturated.
    expect(singleCalls).toEqual([]);
  });

  it("warns with the server's own message, so the operator learns WHY", async () => {
    tagAc(AC_NO_BREAK);
    const { fetchMock } = countingTransport(shed);
    await emitBatch(entries(3), fetchMock as unknown as typeof fetch);

    const warned = warnings.join("\n");
    expect(warned).toContain("429");
    // The body carries the fix; a status code alone leaves the reader guessing.
    expect(warned).toContain("shedding load");
  });

  it("never retries — a 429 means the server is protecting itself", async () => {
    tagAc(AC_NO_BREAK);
    const { fetchMock } = countingTransport(shed);
    await emitBatch(entries(50), fetchMock as unknown as typeof fetch);
    // Retrying would convert one refused request into several at the exact moment the
    // server is shedding — turning a small degradation into an outage.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not throw, so a shed cannot fail a test run", async () => {
    tagAc(AC_NO_BREAK);
    const { fetchMock } = countingTransport(shed);
    await expect(
      emitBatch(entries(10), fetchMock as unknown as typeof fetch),
    ).resolves.toBeUndefined();
  });
});

describe("spec-525 ac-3: the single-POST shape absorbs a 429 too", () => {
  // WHAT THIS PROVES, AND WHAT IT DOES NOT — read before citing it.
  //
  // It proves the SINGLE-POST WIRE SHAPE — one request per event, warn-and-drop on
  // non-2xx, no retry — survives being refused. That is the shape 0.2.0 used, and the
  // shape 24 packages across 6 repos are still pinned to.
  //
  // It does NOT prove the published 0.2.0 PACKAGE behaves this way: that would need
  // the registry copy in the tree, which fights std-24's one-version-per-workspace
  // rule. The shape is retained in this version as the 404/405 fallback path, and it
  // is the request/response handling that decides whether a client breaks — but the
  // stronger claim has not been made here, and a green run should not be read as it.
  //
  // (The task cites commit `44c924e9` for this shape; that commit is a dependabot
  //  @types/node bump. The real boundary is `de0aff2b`, the 0.3.0 batching bump —
  //  see the mismatch registered on t-7.)
  it("warns, does not retry, does not throw, and the run stays green", async () => {
    tagAc(AC_NO_BREAK);
    const { fetchMock, singleCalls, batchCalls } = countingTransport(shed);

    await expect(
      emit(
        {
          ac_uid: "mindset-prod/foo/specs/spec-1/acs/ac-1",
          status: "pass",
          test_identifier: "legacy.test.ts::t",
          duration_ms: 1,
        },
        fetchMock as unknown as typeof fetch,
      ),
    ).resolves.toBeUndefined();

    expect(singleCalls).toHaveLength(1);
    expect(batchCalls).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(1); // no retry
    expect(warnings.join("\n")).toContain("429");
  });
});

describe("spec-525 ac-3: a shed costs the run no measurable time", () => {
  it("a refused batch returns promptly — the client never waits on the server's behalf", async () => {
    tagAc(AC_NO_BREAK);
    const { fetchMock } = countingTransport(shed);

    const started = performance.now();
    await emitBatch(entries(100), fetchMock as unknown as typeof fetch);
    const elapsed = performance.now() - started;

    // The server-side wait is bounded far inside the client's 5s per-request timeout,
    // so a shed is a fast refusal from the client's point of view. The bound here is
    // deliberately loose: the claim is "nothing waits", not a latency budget, and a
    // tight number would make this flaky on a loaded CI box for no added meaning.
    expect(elapsed).toBeLessThan(1000);
  });
});
