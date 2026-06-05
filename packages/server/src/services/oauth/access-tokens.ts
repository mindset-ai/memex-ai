// OAuth 2.1 access tokens — JWTs signed with AUTH_JWT_SECRET (per b-31 dec-3).
//
// Why a parallel file to services/auth-jwt.ts: session tokens only carry `sub`;
// OAuth access tokens carry `sub` + `client_id` + `scope` + `iss/aud`. Keeping
// the two issuers separate makes the audit story easy ("a session token can
// never be replayed as an OAuth access token; their `iss` values differ").
//
// Stateless — these are NEVER persisted. The token verifies if the HMAC checks
// out AND it isn't expired. Refresh tokens are the persisted half; see
// refresh-tokens.ts.

import { createHmac, timingSafeEqual, randomBytes } from "node:crypto";

const ISSUER = "memex-oauth";
const DEFAULT_TTL_SECONDS = 60 * 60; // 1 hour per b-31 dec-3.

export interface OAuthAccessTokenClaims {
  /** User ID (users.id). */
  sub: string;
  /** Issuer — distinguishes OAuth access tokens from session JWTs. */
  iss: typeof ISSUER;
  /** Audience — the resource server. Always 'memex-mcp'. */
  aud: "memex-mcp";
  /** OAuth client (oauth_clients.id) that issued this token. */
  client_id: string;
  /**
   * Org-scope for this grant (per b-31 dec-8). The token grants access to
   * the user's personal Memex + any Memex within this Org. Null when the
   * grant covers personal-only (user has no Org memberships).
   */
  org: string | null;
  /** Granted scopes (space-separated per RFC 6749). */
  scope: string;
  /**
   * JWT ID (RFC 7519 §4.1.7) — random per mint so two access tokens issued in
   * the same second for the same (user, client, org, scope) are still distinct.
   */
  jti: string;
  iat: number;
  exp: number;
}

function base64urlEncode(buf: Buffer | string): string {
  const b = typeof buf === "string" ? Buffer.from(buf) : buf;
  return b
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function base64urlDecode(s: string): Buffer {
  const pad = s.length % 4 === 2 ? "==" : s.length % 4 === 3 ? "=" : "";
  return Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/") + pad, "base64");
}

function getSecret(): string {
  const secret = process.env.AUTH_JWT_SECRET;
  if (secret && secret.length >= 32) return secret;
  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "AUTH_JWT_SECRET is required in production (min 32 chars). Generate with `openssl rand -base64 48`.",
    );
  }
  return "dev-only-jwt-secret-change-in-production-12345678";
}

export class InvalidAccessTokenError extends Error {
  constructor(reason: string) {
    super(`Invalid OAuth access token: ${reason}`);
    this.name = "InvalidAccessTokenError";
  }
}

export interface SignAccessTokenInput {
  userId: string;
  /** Chosen Org for this grant (per b-31 dec-8). null for personal-only. */
  orgId: string | null;
  clientId: string;
  scopes: string[];
  ttlSeconds?: number;
}

export function signAccessToken(input: SignAccessTokenInput): string {
  const now = Math.floor(Date.now() / 1000);
  const ttl = input.ttlSeconds ?? DEFAULT_TTL_SECONDS;
  const header = { alg: "HS256", typ: "JWT" };
  const payload: OAuthAccessTokenClaims = {
    sub: input.userId,
    iss: ISSUER,
    aud: "memex-mcp",
    client_id: input.clientId,
    org: input.orgId,
    scope: input.scopes.join(" "),
    jti: randomBytes(16).toString("base64url"),
    iat: now,
    exp: now + ttl,
  };

  const encodedHeader = base64urlEncode(JSON.stringify(header));
  const encodedPayload = base64urlEncode(JSON.stringify(payload));
  const signingInput = `${encodedHeader}.${encodedPayload}`;
  const signature = createHmac("sha256", getSecret()).update(signingInput).digest();
  return `${signingInput}.${base64urlEncode(signature)}`;
}

export function verifyAccessToken(token: string): OAuthAccessTokenClaims {
  const parts = token.split(".");
  if (parts.length !== 3) throw new InvalidAccessTokenError("malformed");

  const [encodedHeader, encodedPayload, encodedSignature] = parts;
  const signingInput = `${encodedHeader}.${encodedPayload}`;
  const expected = createHmac("sha256", getSecret()).update(signingInput).digest();
  const actual = base64urlDecode(encodedSignature);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    throw new InvalidAccessTokenError("signature mismatch");
  }

  let claims: OAuthAccessTokenClaims;
  try {
    claims = JSON.parse(base64urlDecode(encodedPayload).toString("utf8"));
  } catch {
    throw new InvalidAccessTokenError("payload not valid JSON");
  }

  // Reject session tokens — they share the secret but have iss undefined.
  // Rejecting wrong-issuer prevents one token type from being replayed as
  // the other.
  if (claims.iss !== ISSUER) throw new InvalidAccessTokenError("wrong issuer");
  if (claims.aud !== "memex-mcp") throw new InvalidAccessTokenError("wrong audience");
  if (typeof claims.sub !== "string" || !claims.sub) throw new InvalidAccessTokenError("missing sub");
  if (typeof claims.client_id !== "string" || !claims.client_id) {
    throw new InvalidAccessTokenError("missing client_id");
  }
  // `org` may be null (personal-only) but the FIELD must be present so callers
  // can rely on `claims.org !== undefined` to confirm this is a post-dec-8
  // token. The MUST-be-present check is enforced by the type narrowing here:
  // null and string both pass; undefined trips the conditional.
  if (claims.org !== null && typeof claims.org !== "string") {
    throw new InvalidAccessTokenError("missing org");
  }
  if (typeof claims.exp !== "number") throw new InvalidAccessTokenError("missing exp");
  if (typeof claims.iat !== "number") throw new InvalidAccessTokenError("missing iat");

  const now = Math.floor(Date.now() / 1000);
  if (claims.exp < now) throw new InvalidAccessTokenError("expired");
  // Allow a small future skew (60 s) so a freshly-signed token from a peer
  // with a slightly-fast clock still verifies; anything beyond that is
  // suspicious (clock-skew probe or a forged future-dated token).
  if (claims.iat > now + 60) throw new InvalidAccessTokenError("iat in the future");

  return claims;
}
