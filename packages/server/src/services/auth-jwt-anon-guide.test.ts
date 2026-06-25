// spec-222 t-10 (dec-4 → ac-14) — the anonymous voice-guide session token.
// Proves the signed token binds {surface, issued_at, nonce} with NO user/tenant,
// round-trips, rejects on expiry + tamper, and is cryptographically distinct from
// a user session token (neither family can be replayed as the other).

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { tagAc } from "@memex-ai-ac/vitest";
import {
  signAnonGuideToken,
  verifyAnonGuideToken,
  signSessionToken,
  verifySessionToken,
  InvalidTokenError,
} from "./auth-jwt.js";

const AC14 = "mindset-prod/memex-building-itself/specs/spec-222/acs/ac-14";

function b64url(obj: unknown): string {
  return Buffer.from(JSON.stringify(obj))
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

describe("anonymous guide-session token (ac-14)", () => {
  beforeEach(() => {
    vi.stubEnv("AUTH_JWT_SECRET", "x".repeat(48));
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("mints a token bound to {surface, issued_at, nonce} with no user/tenant, and round-trips", () => {
    tagAc(AC14);
    const { token, expiresAt } = signAnonGuideToken("memex-website", 300);
    const claims = verifyAnonGuideToken(token);
    expect(claims.kind).toBe("guide-anon");
    expect(claims.surface).toBe("memex-website");
    expect(typeof claims.nonce).toBe("string");
    expect(claims.nonce.length).toBeGreaterThan(0);
    expect(claims.iat).toBeGreaterThan(0);
    expect(claims.exp).toBe(expiresAt);
    expect(claims.exp).toBeGreaterThan(claims.iat);
    // No user / no tenant smuggled in.
    expect((claims as Record<string, unknown>).sub).toBeUndefined();
    expect((claims as Record<string, unknown>).memex).toBeUndefined();
  });

  it("mints distinct nonces for two tokens of the same surface", () => {
    tagAc(AC14);
    const a = verifyAnonGuideToken(signAnonGuideToken("memex-website").token);
    const b = verifyAnonGuideToken(signAnonGuideToken("memex-website").token);
    expect(a.nonce).not.toBe(b.nonce);
  });

  it("rejects an expired token", () => {
    tagAc(AC14);
    const { token } = signAnonGuideToken("memex-website", -1); // already expired
    expect(() => verifyAnonGuideToken(token)).toThrow(InvalidTokenError);
  });

  it("rejects a tampered payload (signature mismatch)", () => {
    tagAc(AC14);
    const { token } = signAnonGuideToken("memex-website");
    const [h, , s] = token.split(".");
    // Swap the surface to the app corpus without re-signing.
    const forged = `${h}.${b64url({
      kind: "guide-anon",
      surface: "memex-app",
      nonce: "n",
      iat: 0,
      exp: 2 ** 31,
    })}.${s}`;
    expect(() => verifyAnonGuideToken(forged)).toThrow(InvalidTokenError);
  });

  it("rejects a malformed token", () => {
    tagAc(AC14);
    expect(() => verifyAnonGuideToken("not-a-token")).toThrow(InvalidTokenError);
    expect(() => verifyAnonGuideToken("a.b")).toThrow(InvalidTokenError);
  });

  it("cannot be swapped with a user session token (kind discriminator)", () => {
    tagAc(AC14);
    // A user session token (carries sub, no kind) must NOT verify as an anon token.
    const sessionToken = signSessionToken("user-123");
    expect(() => verifyAnonGuideToken(sessionToken)).toThrow(InvalidTokenError);
    // And an anon token (no sub) must NOT verify as a session token.
    const { token: anon } = signAnonGuideToken("memex-website");
    expect(() => verifySessionToken(anon)).toThrow(InvalidTokenError);
  });
});
