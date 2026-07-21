// spec-489 G1 — emitBatch(): flush MANY emissions in ONE request. The durable
// relief for the CI-burst problem — a suite that tags N tests makes ~one request
// per file instead of N per-test POSTs (ac-3). Same fail-safe contract as emit().
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { emitBatch, tagAc } from "./index.js";

const AC489 = "mindset-prod/memex-building-itself/specs/spec-489/acs";

const okBatchResponse = (accepted: number) => ({
  ok: true,
  status: 200,
  headers: new Headers(),
  json: async () => ({ accepted, rejected: 0, results: [] }),
});

const entry = (over: Partial<{ ac_uid: string; test_identifier: string }> = {}) => ({
  ac_uid: "mindset-prod/foo/specs/spec-1/acs/ac-1",
  status: "pass" as const,
  test_identifier: "test.ts::t",
  duration_ms: 1,
  ...over,
});

beforeEach(() => {
  vi.stubEnv("MEMEX_EMIT", "");
  vi.stubEnv("MEMEX_EMIT_KEY", "");
  vi.stubEnv("MEMEX_TEST_EVENTS_URL", "");
  // Clear the actor fallback chain so payload assertions are stable.
  vi.stubEnv("GITHUB_ACTOR", "");
  vi.stubEnv("GITLAB_USER_LOGIN", "");
  vi.stubEnv("BUILDKITE_BUILD_AUTHOR", "");
  vi.stubEnv("CIRCLE_USERNAME", "");
  vi.stubEnv("USER", "");
  vi.stubEnv("USERNAME", "");
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("emitBatch() — one request carries many events (spec-489 G1)", () => {
  it("posts a SINGLE batch request for N entries, collapsing N round trips to 1 (ac-3)", async () => {
    tagAc(`${AC489}/ac-3`);
    const fetchMock = vi.fn().mockResolvedValue(okBatchResponse(5));
    vi.stubGlobal("fetch", fetchMock);

    const entries = Array.from({ length: 5 }, (_, i) =>
      entry({ test_identifier: `test.ts::t${i}` }),
    );
    await emitBatch(entries);

    // 5 tagged results, ONE HTTP request (and one pool slot), not 5.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://memex.ai/api/test-events/batch");
    expect(init.method).toBe("POST");
    const body = JSON.parse(init.body as string) as { events: unknown[] };
    expect(body.events).toHaveLength(5);
  });

  it("makes ZERO requests when MEMEX_EMIT is off (ac-3 — off switch honoured)", async () => {
    tagAc(`${AC489}/ac-3`);
    vi.stubEnv("MEMEX_EMIT", "false");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await emitBatch([entry(), entry()]);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("makes ZERO requests for an empty buffer (no tagged tests → no HTTP)", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await emitBatch([]);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("drops entries whose ref can't be routed, batching only the valid ones", async () => {
    const fetchMock = vi.fn().mockResolvedValue(okBatchResponse(1));
    vi.stubGlobal("fetch", fetchMock);

    await emitBatch([
      entry({ ac_uid: "" }), // malformed — no namespace, dropped
      entry({ ac_uid: "mindset-prod/foo/specs/spec-1/acs/ac-1" }),
    ]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as { events: unknown[] };
    expect(body.events).toHaveLength(1);
  });

  it("sends one batch PER destination when a file mixes namespaces", async () => {
    const fetchMock = vi.fn().mockResolvedValue(okBatchResponse(1));
    vi.stubGlobal("fetch", fetchMock);

    await emitBatch([
      entry({ ac_uid: "mindset-prod/foo/specs/spec-1/acs/ac-1" }),
      entry({ ac_uid: "mindset-int/foo/specs/spec-1/acs/ac-1" }),
    ]);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const urls = fetchMock.mock.calls.map((c) => c[0]);
    expect(urls).toContain("https://memex.ai/api/test-events/batch");
    expect(urls).toContain("https://int.memex.ai/api/test-events/batch");
  });

  it("attaches Authorization: Bearer <key> and Content-Type on the batch request (spec-129)", async () => {
    vi.stubEnv("MEMEX_EMIT_KEY", "mxk_batch_key");
    const fetchMock = vi.fn().mockResolvedValue(okBatchResponse(1));
    vi.stubGlobal("fetch", fetchMock);

    await emitBatch([entry()]);

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer mxk_batch_key");
    expect(headers["Content-Type"]).toBe("application/json");
  });

  it("sends NO Authorization header when MEMEX_EMIT_KEY is unset (batch still attempted)", async () => {
    const fetchMock = vi.fn().mockResolvedValue(okBatchResponse(1));
    vi.stubGlobal("fetch", fetchMock);

    await emitBatch([entry()]);

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBeUndefined();
  });
});

describe("emitBatch() — fail-safe contract (spec-489 G1, mirrors emit())", () => {
  it("does NOT throw and surfaces the body on a non-2xx batch response", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      headers: new Headers(),
      text: async () => "call provision_ac_emission for a fresh key",
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(emitBatch([entry(), entry()])).resolves.toBeUndefined();
    const warned = warnSpy.mock.calls.flat().join(" ");
    expect(warned).toContain("401");
    expect(warned).toContain("call provision_ac_emission for a fresh key");
    warnSpy.mockRestore();
  });

  it("does NOT throw when fetch itself rejects (network error swallowed)", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetchMock = vi.fn().mockRejectedValue(new Error("network down"));
    vi.stubGlobal("fetch", fetchMock);

    await expect(emitBatch([entry()])).resolves.toBeUndefined();
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("bounds the batch POST with an AbortSignal so a hung server cannot stall the suite", async () => {
    const fetchMock = vi.fn().mockResolvedValue(okBatchResponse(1));
    vi.stubGlobal("fetch", fetchMock);

    await emitBatch([entry()]);

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("falls back to single-event POSTs when the server has no /batch route (404) — rollout safety", async () => {
    tagAc(`${AC489}/ac-3`);
    // Older server / self-hosted install without the batch endpoint: /batch 404s.
    // The emitter must still land every event via the single-event route so a
    // deploy-ordering gap never drops emissions.
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url.endsWith("/batch")) {
        return Promise.resolve({ ok: false, status: 404, headers: new Headers(), text: async () => "Not Found" });
      }
      return Promise.resolve({ ok: true, status: 201, headers: new Headers() });
    });
    vi.stubGlobal("fetch", fetchMock);

    await emitBatch([
      entry({ test_identifier: "a" }),
      entry({ test_identifier: "b" }),
      entry({ test_identifier: "c" }),
    ]);

    const urls = fetchMock.mock.calls.map((c) => c[0] as string);
    // One /batch attempt, then one single POST per event (3) once it 404s.
    expect(urls.filter((u) => u.endsWith("/batch"))).toHaveLength(1);
    expect(urls.filter((u) => u === "https://memex.ai/api/test-events")).toHaveLength(3);
  });

  it("does the same fallback on a 405 (method/route not present)", async () => {
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url.endsWith("/batch")) {
        return Promise.resolve({ ok: false, status: 405, headers: new Headers(), text: async () => "" });
      }
      return Promise.resolve({ ok: true, status: 201, headers: new Headers() });
    });
    vi.stubGlobal("fetch", fetchMock);

    await emitBatch([entry()]);

    const urls = fetchMock.mock.calls.map((c) => c[0] as string);
    expect(urls).toContain("https://memex.ai/api/test-events/batch");
    expect(urls).toContain("https://memex.ai/api/test-events");
  });

  it("surfaces per-event rejections carried in a 200 batch body (partial failure stays loud, spec-333)", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers(),
      json: async () => ({
        accepted: 1,
        rejected: 1,
        results: [
          { index: 0, ok: true, id: "x" },
          { index: 1, ok: false, error: "scoped to Spec spec-999" },
        ],
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(emitBatch([entry(), entry()])).resolves.toBeUndefined();
    const warned = warnSpy.mock.calls.flat().join(" ");
    expect(warned).toContain("rejected");
    expect(warned).toContain("scoped to Spec spec-999");
    warnSpy.mockRestore();
  });
});
