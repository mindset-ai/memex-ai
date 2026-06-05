import { describe, it, expect, beforeEach } from "vitest";
import {
  signAccessToken,
  verifyAccessToken,
  InvalidAccessTokenError,
} from "./access-tokens.js";
import { signSessionToken } from "../auth-jwt.js";

const USER_ID = "00000000-0000-0000-0000-00000000beef";
const CLIENT_ID = "00000000-0000-0000-0000-00000000c11e";
const ORG_ID = "00000000-0000-0000-0000-000000000a01";

beforeEach(() => {
  // Pin the secret so signSessionToken + signAccessToken share it. Both fall
  // back to the dev secret when AUTH_JWT_SECRET is unset; tests use the
  // dev fallback explicitly.
  delete process.env.AUTH_JWT_SECRET;
});

describe("OAuth access tokens", () => {
  it("sign + verify round-trip preserves claims", () => {
    const token = signAccessToken({
      userId: USER_ID,
      orgId: ORG_ID,
      clientId: CLIENT_ID,
      scopes: ["memex.full"],
    });
    const claims = verifyAccessToken(token);
    expect(claims.sub).toBe(USER_ID);
    expect(claims.org).toBe(ORG_ID);
    expect(claims.client_id).toBe(CLIENT_ID);
    expect(claims.iss).toBe("memex-oauth");
    expect(claims.aud).toBe("memex-mcp");
    expect(claims.scope).toBe("memex.full");
    expect(claims.exp).toBeGreaterThan(claims.iat);
    expect(claims.exp - claims.iat).toBe(3600);
  });

  it("personal-only grant (orgId=null) round-trips with claims.org === null", () => {
    const token = signAccessToken({
      userId: USER_ID,
      orgId: null,
      clientId: CLIENT_ID,
      scopes: ["memex.full"],
    });
    expect(verifyAccessToken(token).org).toBeNull();
  });

  it("custom TTL is honoured", () => {
    const token = signAccessToken({
      userId: USER_ID,
      orgId: ORG_ID,
      clientId: CLIENT_ID,
      scopes: ["memex.full"],
      ttlSeconds: 60,
    });
    const claims = verifyAccessToken(token);
    expect(claims.exp - claims.iat).toBe(60);
  });

  it("multi-scope serialises space-separated per RFC 6749", () => {
    const token = signAccessToken({
      userId: USER_ID,
      orgId: ORG_ID,
      clientId: CLIENT_ID,
      scopes: ["memex.read", "memex.write"],
    });
    expect(verifyAccessToken(token).scope).toBe("memex.read memex.write");
  });

  it("rejects a malformed token", () => {
    expect(() => verifyAccessToken("not.a.jwt")).toThrow(InvalidAccessTokenError);
  });

  it("rejects a token signed with a different secret", () => {
    const token = signAccessToken({
      userId: USER_ID,
      orgId: ORG_ID,
      clientId: CLIENT_ID,
      scopes: ["memex.full"],
    });
    // Mid-test secret swap → signature should now mismatch.
    process.env.AUTH_JWT_SECRET = "a-completely-different-secret-32-chars!!";
    expect(() => verifyAccessToken(token)).toThrow(/signature mismatch/);
  });

  it("rejects an expired token", () => {
    const token = signAccessToken({
      userId: USER_ID,
      orgId: ORG_ID,
      clientId: CLIENT_ID,
      scopes: ["memex.full"],
      ttlSeconds: -1, // expired one second ago
    });
    expect(() => verifyAccessToken(token)).toThrow(/expired/);
  });

  it("rejects a session JWT signed with the same secret (iss check)", () => {
    // Critical isolation: a session token has no `iss`, so verifyAccessToken
    // must reject it even though the signature is mathematically valid.
    const sessionJwt = signSessionToken(USER_ID);
    expect(() => verifyAccessToken(sessionJwt)).toThrow(/wrong issuer/);
  });

  it("rejects a token with a tampered payload", () => {
    const token = signAccessToken({
      userId: USER_ID,
      orgId: ORG_ID,
      clientId: CLIENT_ID,
      scopes: ["memex.full"],
    });
    const [h, p, s] = token.split(".");
    // Re-encode payload with a different sub but keep the old signature.
    const tampered = Buffer.from(`{"sub":"attacker","iss":"memex-oauth","aud":"memex-mcp","client_id":"${CLIENT_ID}","org":"${ORG_ID}","scope":"memex.full","iat":1,"exp":9999999999}`).toString("base64url");
    expect(() => verifyAccessToken(`${h}.${tampered}.${s}`)).toThrow(/signature mismatch/);
  });

  it("rejects a token whose iat is more than 60s in the future", async () => {
    // signAccessToken always stamps iat=now, so we hand-craft the JWT with a
    // future-dated iat and re-sign with the dev secret. 1h skew → must reject.
    const { createHmac } = await import("node:crypto");
    const now = Math.floor(Date.now() / 1000);
    const header = Buffer.from('{"alg":"HS256","typ":"JWT"}').toString("base64url");
    const payload = Buffer.from(
      `{"sub":"${USER_ID}","iss":"memex-oauth","aud":"memex-mcp","client_id":"${CLIENT_ID}","org":"${ORG_ID}","scope":"memex.full","iat":${now + 3600},"exp":${now + 7200}}`,
    ).toString("base64url");
    const signingInput = `${header}.${payload}`;
    const sig = createHmac("sha256", "dev-only-jwt-secret-change-in-production-12345678")
      .update(signingInput)
      .digest("base64url");
    expect(() => verifyAccessToken(`${signingInput}.${sig}`)).toThrow(/iat in the future/);
  });

  it("accepts an iat within the 60s skew tolerance", async () => {
    const { createHmac } = await import("node:crypto");
    const now = Math.floor(Date.now() / 1000);
    const header = Buffer.from('{"alg":"HS256","typ":"JWT"}').toString("base64url");
    const payload = Buffer.from(
      `{"sub":"${USER_ID}","iss":"memex-oauth","aud":"memex-mcp","client_id":"${CLIENT_ID}","org":"${ORG_ID}","scope":"memex.full","iat":${now + 30},"exp":${now + 3630}}`,
    ).toString("base64url");
    const signingInput = `${header}.${payload}`;
    const sig = createHmac("sha256", "dev-only-jwt-secret-change-in-production-12345678")
      .update(signingInput)
      .digest("base64url");
    const claims = verifyAccessToken(`${signingInput}.${sig}`);
    expect(claims.iat).toBe(now + 30);
  });

  it("rejects a token whose iat is not a number", async () => {
    // Hand-craft a payload with iat set to a string — the verifier MUST flag
    // it as missing rather than silently treat it as 0.
    const { createHmac } = await import("node:crypto");
    const now = Math.floor(Date.now() / 1000);
    const header = Buffer.from('{"alg":"HS256","typ":"JWT"}').toString("base64url");
    const payload = Buffer.from(
      `{"sub":"${USER_ID}","iss":"memex-oauth","aud":"memex-mcp","client_id":"${CLIENT_ID}","org":"${ORG_ID}","scope":"memex.full","iat":"not-a-number","exp":${now + 3600}}`,
    ).toString("base64url");
    const signingInput = `${header}.${payload}`;
    const sig = createHmac("sha256", "dev-only-jwt-secret-change-in-production-12345678")
      .update(signingInput)
      .digest("base64url");
    expect(() => verifyAccessToken(`${signingInput}.${sig}`)).toThrow(/missing iat/);
  });

  it("rejects a token that lacks the org claim entirely (pre-dec-8 shape)", async () => {
    // Hand-craft a token with no `org` field. The verifier guards against
    // the legacy shape — if a stray pre-dec-8 token resurfaces, we WANT it
    // rejected rather than silently treated as "personal-only".
    const { createHmac } = await import("node:crypto");
    const header = Buffer.from('{"alg":"HS256","typ":"JWT"}').toString("base64url");
    const payload = Buffer.from(
      `{"sub":"${USER_ID}","iss":"memex-oauth","aud":"memex-mcp","client_id":"${CLIENT_ID}","scope":"memex.full","iat":1,"exp":9999999999}`,
    ).toString("base64url");
    const signingInput = `${header}.${payload}`;
    const sig = createHmac("sha256", "dev-only-jwt-secret-change-in-production-12345678")
      .update(signingInput)
      .digest("base64url");
    expect(() => verifyAccessToken(`${signingInput}.${sig}`)).toThrow(/missing org/);
  });
});
