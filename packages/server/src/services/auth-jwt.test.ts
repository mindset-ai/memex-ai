import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  signSessionToken,
  verifySessionToken,
  generateOpaqueToken,
  InvalidTokenError,
} from "./auth-jwt.js";
import { signAccessToken } from "./oauth/access-tokens.js";

describe("session JWT", () => {
  beforeEach(() => {
    vi.stubEnv("AUTH_JWT_SECRET", "x".repeat(48));
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("round-trips sub + exp claims", () => {
    const token = signSessionToken("user-123");
    const claims = verifySessionToken(token);
    expect(claims.sub).toBe("user-123");
    expect(claims.exp).toBeGreaterThan(claims.iat);
  });

  it("rejects a tampered payload", () => {
    const token = signSessionToken("user-123");
    const parts = token.split(".");
    const tamperedPayload = Buffer.from(
      JSON.stringify({ sub: "evil-attacker", iat: 0, exp: 2 ** 31 }),
    )
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    const forged = [parts[0], tamperedPayload, parts[2]].join(".");
    expect(() => verifySessionToken(forged)).toThrow(InvalidTokenError);
  });

  it("rejects a token with a different secret", () => {
    const token = signSessionToken("user-123");
    vi.stubEnv("AUTH_JWT_SECRET", "y".repeat(48));
    expect(() => verifySessionToken(token)).toThrow(InvalidTokenError);
  });

  it("rejects an OAuth access token replayed as a session token", () => {
    // OAuth access tokens are signed with the same AUTH_JWT_SECRET and carry
    // sub + exp, but stamp iss="memex-oauth". A 1-hour MCP token must never be
    // accepted as a 30-day UI session — verifyAccessToken enforces the mirror
    // check; this asserts the reverse direction (b-31 dec-3).
    const accessToken = signAccessToken({
      userId: "user-123",
      orgId: null,
      clientId: "client-abc",
      scopes: ["mcp"],
    });
    expect(() => verifySessionToken(accessToken)).toThrow(/unexpected issuer/);
  });

  it("rejects an expired token", () => {
    const token = signSessionToken("user-123", -60); // already expired
    expect(() => verifySessionToken(token)).toThrow(/expired/);
  });

  it("rejects a structurally malformed token", () => {
    expect(() => verifySessionToken("not.a.jwt.maybe")).toThrow(InvalidTokenError);
    expect(() => verifySessionToken("onlytwo.parts")).toThrow(InvalidTokenError);
  });

  it("generates opaque tokens of expected length", () => {
    const t1 = generateOpaqueToken(32);
    const t2 = generateOpaqueToken(32);
    expect(t1).not.toBe(t2);
    // 32 bytes → 43 base64url chars (no padding)
    expect(t1).toHaveLength(43);
  });
});
