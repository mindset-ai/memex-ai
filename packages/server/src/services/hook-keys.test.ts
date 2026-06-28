import { describe, it, expect } from "vitest";
import { tagAc } from "@memex-ai-ac/vitest";
import {
  generateRawHookKey,
  hashHookKey,
  hookKeyDisplayPrefix,
} from "./hook-keys.js";

// spec-371 t-1 — scoped hook-credential primitives (pure, no DB).
// ac-14 (dec-6): the hook authenticates with its OWN dedicated, capability-scoped,
// long-lived credential — minted/hashed mxh_-style, never the user's mxt_/OAuth.
const AC_14 = "mindset-prod/memex-building-itself/specs/spec-371/acs/ac-14";

describe("hook-keys: key primitives (spec-371 ac-14)", () => {
  it("every key starts with the literal `mxh_` prefix — its own namespace, not mxt_", () => {
    tagAc(AC_14);
    for (let i = 0; i < 100; i++) {
      const raw = generateRawHookKey();
      expect(raw.startsWith("mxh_")).toBe(true);
      expect(raw.startsWith("mxt_")).toBe(false);
    }
  });

  it("carries at least 256 bits of entropy (random payload decodes to >=32 bytes)", () => {
    tagAc(AC_14);
    const payload = generateRawHookKey().slice("mxh_".length);
    expect(Buffer.from(payload, "base64url").length).toBeGreaterThanOrEqual(32);
  });

  it("is unique across many generations (no CSPRNG collision)", () => {
    tagAc(AC_14);
    const seen = new Set<string>();
    for (let i = 0; i < 5000; i++) seen.add(generateRawHookKey());
    expect(seen.size).toBe(5000);
  });

  it("displayPrefix exposes only `mxh_` + 8 chars, never the full secret", () => {
    tagAc(AC_14);
    const raw = generateRawHookKey();
    const prefix = hookKeyDisplayPrefix(raw);
    expect(prefix).toBe(raw.slice(0, "mxh_".length + 8));
    expect(prefix.length).toBe("mxh_".length + 8);
    expect(raw.startsWith(prefix)).toBe(true);
    expect(prefix.length).toBeLessThan(raw.length);
  });

  it("hashHookKey is a deterministic SHA-256 hex digest of the raw key", () => {
    tagAc(AC_14);
    const raw = generateRawHookKey();
    expect(hashHookKey(raw)).toBe(hashHookKey(raw));
    expect(hashHookKey(raw)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashHookKey(raw)).not.toBe(raw);
  });
});
