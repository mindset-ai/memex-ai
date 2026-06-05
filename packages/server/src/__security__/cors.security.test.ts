import { describe, it, expect } from "vitest";
import { isAllowedOrigin } from "../middleware/cors-policy.js";

// Guards b-31/W3 (t-8): Claude origins must reach `/mcp` and the API surface,
// but suffix-attack lookalikes must not. The cors() helper rejects unknowns by
// returning `null`, so a single origin-classification function is the only
// thing worth asserting here.
describe("security: CORS origin allowlist", () => {
  describe("known-good origins", () => {
    it.each([
      "https://memex.ai",
      "https://int.memex.ai",
      "http://localhost:5173",
      "http://localhost:8000",
      "https://claude.ai",
      "https://claude.com",
    ])("allows %s", (origin) => {
      expect(isAllowedOrigin(origin)).toBe(true);
    });

    it.each([
      "https://app.anthropic.com",
      "https://api.anthropic.com",
      "https://console.anthropic.com",
    ])("allows Anthropic subdomain %s via suffix match", (origin) => {
      expect(isAllowedOrigin(origin)).toBe(true);
    });
  });

  describe("suffix-attack rejections", () => {
    it.each([
      // No leading dot — must not match `*.anthropic.com`.
      "https://evil-anthropic.com",
      // Path/host injection variants.
      "https://anthropic.com.evil.io",
      "https://app.anthropic.com.evil.io",
      // claude.* lookalikes.
      "https://evil-claude.ai",
      "https://claude.ai.evil.io",
      // Wrong scheme — Anthropic subdomain suffix requires https.
      "http://app.anthropic.com",
      // Plain "anthropic.com" without a subdomain is intentionally not in the
      // allowlist; Anthropic surfaces are subdomain-scoped.
      "https://anthropic.com",
    ])("rejects %s", (origin) => {
      expect(isAllowedOrigin(origin)).toBe(false);
    });
  });

  describe("malformed inputs", () => {
    it.each(["", "not-a-url", "javascript:alert(1)", "//attacker.io"])(
      "rejects malformed origin %s",
      (origin) => {
        expect(isAllowedOrigin(origin)).toBe(false);
      },
    );
  });
});
