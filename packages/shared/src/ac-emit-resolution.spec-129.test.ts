import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
// Import BY PACKAGE NAME (not a relative path) so this exercises the real
// workspace-consumer resolution path — the exact path that silently ran a
// stale, keyless `dist/` in spec-129/issue-1. With the `development` export
// condition, vitest resolves this to the live `src/`, so the dec-2
// MEMEX_EMIT_KEY → Authorization: Bearer transport is guaranteed present.
import { emit, tagAc } from "@memex-ai-ac/vitest";

const AC = "mindset-prod/memex-building-itself/specs/spec-129/acs";

const baseArgs = {
  ac_uid: "mindset-prod/foo/specs/spec-1/acs/ac-1",
  status: "pass" as const,
  test_identifier: "ac-emit-resolution.spec-129.test.ts::consumer",
  duration_ms: 1,
};

beforeEach(() => {
  vi.stubEnv("MEMEX_EMIT", "");
});

afterEach(() => {
  // Runs BEFORE the setup-file afterEach (LIFO), so the real MEMEX_EMIT_KEY is
  // restored before this test's own tagged emission goes out.
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("workspace-consumer resolution carries the dec-2 transport (spec-129 ac-23)", () => {
  it("the by-name-imported helper attaches Authorization: Bearer when MEMEX_EMIT_KEY is set", async () => {
    tagAc(`${AC}/ac-23`);
    tagAc(`${AC}/ac-7`);
    vi.stubEnv("MEMEX_EMIT_KEY", "mxk_resolution_probe");
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 201,
      headers: new Headers(),
    });
    vi.stubGlobal("fetch", fetchMock);

    await emit(baseArgs);

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://memex.ai/api/test-events");
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer mxk_resolution_probe");
  });
});
