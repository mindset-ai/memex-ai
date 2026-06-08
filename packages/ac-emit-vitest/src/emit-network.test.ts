import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { emit, tagAc } from "./index.js";

const AC = "mindset-prod/memex-building-itself/specs/spec-115/acs";

beforeEach(() => {
  // Default emission on; individual tests stub MEMEX_EMIT=false where needed.
  vi.stubEnv("MEMEX_EMIT", "");
  vi.stubEnv("CI", "");
  vi.stubEnv("GITHUB_ACTIONS", "");
  vi.stubEnv("GITLAB_CI", "");
  vi.stubEnv("BUILDKITE", "");
  vi.stubEnv("CIRCLECI", "");
  // Clear the actor fallback chain so payload-shape assertions are stable.
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

describe("emit() — HTTP POST behaviour", () => {
  it("does not call fetch when MEMEX_EMIT=false (ac-7)", async () => {
    tagAc(`${AC}/ac-7`);
    vi.stubEnv("MEMEX_EMIT", "false");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await emit({
      ac_uid: "mindset-prod/foo/specs/spec-1/acs/ac-1",
      status: "pass",
      test_identifier: "test.ts::it works",
      duration_ms: 42,
    });

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("calls fetch when MEMEX_EMIT is unset (ac-6)", async () => {
    tagAc(`${AC}/ac-6`);
    vi.stubEnv("MEMEX_EMIT", "");
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers(),
    });
    vi.stubGlobal("fetch", fetchMock);

    await emit({
      ac_uid: "mindset-prod/foo/specs/spec-1/acs/ac-1",
      status: "pass",
      test_identifier: "test.ts::it works",
      duration_ms: 42,
    });

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://memex.ai/api/test-events");
    expect(init.method).toBe("POST");
  });

  it("calls fetch when MEMEX_EMIT is malformed (treated as on) (ac-9)", async () => {
    tagAc(`${AC}/ac-9`);
    vi.stubEnv("MEMEX_EMIT", "banana");
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers(),
    });
    vi.stubGlobal("fetch", fetchMock);

    await emit({
      ac_uid: "mindset-prod/foo/specs/spec-1/acs/ac-1",
      status: "pass",
      test_identifier: "test.ts::it works",
      duration_ms: 42,
    });

    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("posts the full wire-format payload as JSON body (ac-12)", async () => {
    tagAc(`${AC}/ac-12`);
    vi.stubEnv("GITHUB_ACTOR", "wic");
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers(),
    });
    vi.stubGlobal("fetch", fetchMock);

    await emit({
      ac_uid: "mindset-prod/foo/specs/spec-1/acs/ac-1",
      status: "fail",
      test_identifier: "test.ts::failed",
      duration_ms: 100,
      options: { hidden: true, metadata: { tenant: "acme" } },
    });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body).toMatchObject({
      ac_uid: "mindset-prod/foo/specs/spec-1/acs/ac-1",
      status: "fail",
      test_identifier: "test.ts::failed",
      duration_ms: 100,
      // spec-115 dec-6: actor lives at the top level alongside hidden,
      // not inside metadata.
      actor: "wic",
      hidden: true,
    });
    expect(body.metadata?.tenant).toBe("acme");
    expect(body.metadata?.actor).toBeUndefined();
  });

  it("posts to the SaaS host (memex.ai) when namespace is unknown and no override (spec-90 B1)", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 201,
      headers: { get: () => null },
    });
    vi.stubGlobal("fetch", fetchMock);

    await emit({
      ac_uid: "unknown-ns/foo/specs/spec-1/acs/ac-1",
      status: "pass",
      test_identifier: "test.ts::it works",
      duration_ms: 42,
    });

    // memex.ai serves every customer tenant, so an unmapped namespace defaults
    // there rather than being skipped.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://memex.ai/api/test-events");
  });

  it("does not call fetch when the ref has no namespace at all (malformed)", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await emit({
      ac_uid: "",
      status: "pass",
      test_identifier: "test.ts::it works",
      duration_ms: 42,
    });

    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// spec-129 — emission-key transport + fail-safe on rejection.
const AC_129 = "mindset-prod/memex-building-itself/specs/spec-129/acs";

const baseArgs = {
  ac_uid: "mindset-prod/foo/specs/spec-1/acs/ac-1",
  status: "pass" as const,
  test_identifier: "test.ts::it works",
  duration_ms: 42,
};

describe("emit() — MEMEX_EMIT_KEY transport (spec-129 ac-7)", () => {
  it("attaches Authorization: Bearer <key> when MEMEX_EMIT_KEY is set", async () => {
    tagAc(`${AC_129}/ac-7`);
    tagAc(`${AC_129}/ac-3`); // scope outcome: set MEMEX_EMIT_KEY in env → emissions Just Work
    vi.stubEnv("MEMEX_EMIT_KEY", "mxk_test_key_value");
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 201,
      headers: new Headers(),
    });
    vi.stubGlobal("fetch", fetchMock);

    await emit(baseArgs);

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer mxk_test_key_value");
    expect(headers["Content-Type"]).toBe("application/json");
  });

  it("sends NO Authorization header when MEMEX_EMIT_KEY is unset (emission still attempted)", async () => {
    tagAc(`${AC_129}/ac-7`);
    vi.stubEnv("MEMEX_EMIT_KEY", "");
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 201,
      headers: new Headers(),
    });
    vi.stubGlobal("fetch", fetchMock);

    await emit(baseArgs);

    expect(fetchMock).toHaveBeenCalledOnce();
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBeUndefined();
  });
});

describe("emit() — fail-safe on rejection (spec-129 ac-16)", () => {
  it("does NOT throw when the server returns 401 (enforcement cannot turn a run red)", async () => {
    tagAc(`${AC_129}/ac-16`);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      headers: new Headers(),
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(emit(baseArgs)).resolves.toBeUndefined();
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("does NOT throw when fetch itself rejects (network error)", async () => {
    tagAc(`${AC_129}/ac-16`);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetchMock = vi.fn().mockRejectedValue(new Error("network down"));
    vi.stubGlobal("fetch", fetchMock);

    await expect(emit(baseArgs)).resolves.toBeUndefined();
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("bounds the POST with a client-side timeout so a slow server cannot stall the suite", async () => {
    // A hung (not failed) server response previously rode the awaited fetch
    // past vitest's 10s hookTimeout and FAILED the tagged test — defeating
    // the fail-safe contract, which only swallowed errors, not hangs. The
    // emitter must pass an AbortSignal so a stalled POST aborts into the
    // existing warn-and-continue catch.
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers(),
    });
    vi.stubGlobal("fetch", fetchMock);

    await emit(baseArgs);

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("does NOT throw when the bounded fetch aborts (timeout degrades to warn-and-continue)", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetchMock = vi
      .fn()
      .mockRejectedValue(new DOMException("The operation timed out.", "TimeoutError"));
    vi.stubGlobal("fetch", fetchMock);

    await expect(emit(baseArgs)).resolves.toBeUndefined();
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});
