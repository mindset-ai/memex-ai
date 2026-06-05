import { describe, it, expect, afterEach, vi } from "vitest";
import { tagAc } from "@memex-ai-ac/vitest";

import { getHiddenFeatures } from "./auth.js";

// spec-146 t-1 — the server-driven feature-hide list that rides on every
// session payload (SessionPayload.hiddenFeatures). getHiddenFeatures() is the
// single parse site that populates that field in handleSsoLogin/resolveSession,
// so asserting it here verifies the value the session payload carries to clients.
describe("getHiddenFeatures (session payload hiddenFeatures)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("parses HIDDEN_FEATURES into the session payload's hiddenFeatures, fail-open when unset", () => {
    tagAc("mindset-prod/memex-building-itself/specs/spec-146/acs/ac-7");

    // (a) set → split on comma into the slug list.
    vi.stubEnv("HIDDEN_FEATURES", "scaffold,pulse");
    expect(getHiddenFeatures()).toEqual(["scaffold", "pulse"]);

    // (b) unset/empty → [] (fail-open; never throws, never hides by default).
    vi.stubEnv("HIDDEN_FEATURES", "");
    expect(getHiddenFeatures()).toEqual([]);
    vi.unstubAllEnvs();
    expect(getHiddenFeatures()).toEqual([]);

    // (c) whitespace + empty entries are trimmed and dropped.
    vi.stubEnv("HIDDEN_FEATURES", " scaffold , , pulse ");
    expect(getHiddenFeatures()).toEqual(["scaffold", "pulse"]);
  });
});
