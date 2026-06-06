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
    // Scope ACs verified by this same env-parse contract:
    // ac-3 — hiding is per-environment / all-or-nothing: the slug list is sourced
    //   purely from the process environment (no per-user/role/org input), so every
    //   session minted on an environment carries the identical value.
    // ac-5 — fail-open default: an unset/empty value ⇒ [] ⇒ nothing hidden.
    tagAc("mindset-prod/memex-building-itself/specs/spec-146/acs/ac-3");
    tagAc("mindset-prod/memex-building-itself/specs/spec-146/acs/ac-5");

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
