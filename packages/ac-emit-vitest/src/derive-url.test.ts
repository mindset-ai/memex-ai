import { describe, it, expect, afterEach, vi } from "vitest";
import { deriveEventsUrl } from "./index.js";

describe("deriveEventsUrl — namespace routing", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("routes mindset-int refs to https://int.memex.ai", () => {
    const url = deriveEventsUrl("mindset-int/foo/specs/spec-1/acs/ac-1");
    expect(url).toBe("https://int.memex.ai/api/test-events");
  });

  it("routes mindset-prod refs to https://memex.ai", () => {
    const url = deriveEventsUrl("mindset-prod/foo/specs/spec-1/acs/ac-1");
    expect(url).toBe("https://memex.ai/api/test-events");
  });

  it("returns null for unknown namespace with no override", () => {
    const url = deriveEventsUrl("unknown-ns/foo/specs/spec-1/acs/ac-1");
    expect(url).toBeNull();
  });

  it("returns null for empty namespace", () => {
    const url = deriveEventsUrl("");
    expect(url).toBeNull();
  });

  it("uses MEMEX_TEST_EVENTS_URL override when set", () => {
    vi.stubEnv("MEMEX_TEST_EVENTS_URL", "https://example.com/events");
    const url = deriveEventsUrl("mindset-prod/foo/specs/spec-1/acs/ac-1");
    expect(url).toBe("https://example.com/events");
  });
});
