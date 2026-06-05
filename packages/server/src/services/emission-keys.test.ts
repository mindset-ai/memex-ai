import { describe, it, expect } from "vitest";
import { tagAc } from "@memex-ai-ac/vitest";
import { generateRawKey, hashKey, displayPrefix } from "./emission-keys.js";

// spec-129 t-3 — emission-key generation primitives (pure, no DB).
// ac-6: keys are `mxk_<random>` with >=256 bits of CSPRNG entropy.

const AC_6 = "mindset-prod/memex-building-itself/specs/spec-129/acs/ac-6";

describe("emission-keys: generateRawKey (ac-6)", () => {
  it("every key starts with the literal `mxk_` prefix", () => {
    tagAc(AC_6);
    for (let i = 0; i < 100; i++) {
      expect(generateRawKey().startsWith("mxk_")).toBe(true);
    }
  });

  it("carries at least 256 bits of entropy (random payload decodes to >=32 bytes)", () => {
    tagAc(AC_6);
    const raw = generateRawKey();
    const payload = raw.slice("mxk_".length);
    const bytes = Buffer.from(payload, "base64url");
    expect(bytes.length).toBeGreaterThanOrEqual(32);
  });

  it("is unique across many generations (no CSPRNG collision)", () => {
    tagAc(AC_6);
    const seen = new Set<string>();
    for (let i = 0; i < 5000; i++) seen.add(generateRawKey());
    expect(seen.size).toBe(5000);
  });

  it("displayPrefix exposes only `mxk_` + 8 chars, never the full secret", () => {
    tagAc(AC_6);
    const raw = generateRawKey();
    const prefix = displayPrefix(raw);
    expect(prefix).toBe(raw.slice(0, "mxk_".length + 8));
    expect(prefix.length).toBe("mxk_".length + 8);
    expect(raw.startsWith(prefix)).toBe(true);
    expect(prefix.length).toBeLessThan(raw.length);
  });

  it("hashKey is a deterministic SHA-256 hex digest of the raw key", () => {
    tagAc(AC_6);
    const raw = generateRawKey();
    const h = hashKey(raw);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(hashKey(raw)).toBe(h); // deterministic
    expect(hashKey(generateRawKey())).not.toBe(h); // different key → different hash
  });
});
