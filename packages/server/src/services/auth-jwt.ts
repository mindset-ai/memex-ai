// Minimal HS256 JWT implementation. We hand-roll this to avoid pulling in `jsonwebtoken`
// or `jose` — the spec is small and we only need sign/verify with a shared secret.
// Format: header.payload.signature (each base64url-encoded).
//
// Tokens are issued on successful signup / login / magic-link consumption / Google SSO
// and stored in the client's localStorage. The session middleware verifies on every request.

import { createHmac, timingSafeEqual, randomBytes } from "node:crypto";

const DEFAULT_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days

export interface SessionClaims {
  /** User ID (users.id). */
  sub: string;
  /** Issued-at (seconds since epoch). */
  iat: number;
  /** Expires-at (seconds since epoch). */
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
  // Re-pad to a multiple of 4 before decoding.
  const pad = s.length % 4 === 2 ? "==" : s.length % 4 === 3 ? "=" : "";
  return Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/") + pad, "base64");
}

// Resolves the shared HS256 signing secret (AUTH_JWT_SECRET). Exported so other
// AUTH_JWT_SECRET-signed artifacts (e.g. the Slack OAuth CSRF state token in
// services/.ee/slack/oauth.ts) reuse one resolver instead of duplicating a
// hardcoded dev fallback.
export function getSecret(): string {
  const secret = process.env.AUTH_JWT_SECRET;
  if (secret && secret.length >= 32) return secret;

  // Dev fallback: derive a stable secret for local development so restarts don't
  // invalidate active sessions. Production MUST set AUTH_JWT_SECRET (>=32 chars) —
  // we throw if NODE_ENV=production and the env is missing.
  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "AUTH_JWT_SECRET is required in production (min 32 chars). Generate with `openssl rand -base64 48`."
    );
  }
  return "dev-only-jwt-secret-change-in-production-12345678";
}

export function signSessionToken(userId: string, ttlSeconds = DEFAULT_TTL_SECONDS): string {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "HS256", typ: "JWT" };
  const payload: SessionClaims = { sub: userId, iat: now, exp: now + ttlSeconds };

  const encodedHeader = base64urlEncode(JSON.stringify(header));
  const encodedPayload = base64urlEncode(JSON.stringify(payload));
  const signingInput = `${encodedHeader}.${encodedPayload}`;

  const signature = createHmac("sha256", getSecret()).update(signingInput).digest();
  const encodedSignature = base64urlEncode(signature);

  return `${signingInput}.${encodedSignature}`;
}

export class InvalidTokenError extends Error {
  constructor(reason: string) {
    super(`Invalid session token: ${reason}`);
    this.name = "InvalidTokenError";
  }
}

export function verifySessionToken(token: string): SessionClaims {
  const parts = token.split(".");
  if (parts.length !== 3) throw new InvalidTokenError("malformed");

  const [encodedHeader, encodedPayload, encodedSignature] = parts;
  const signingInput = `${encodedHeader}.${encodedPayload}`;

  const expected = createHmac("sha256", getSecret()).update(signingInput).digest();
  const actual = base64urlDecode(encodedSignature);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    throw new InvalidTokenError("signature mismatch");
  }

  let claims: SessionClaims;
  try {
    claims = JSON.parse(base64urlDecode(encodedPayload).toString("utf8"));
  } catch {
    throw new InvalidTokenError("payload not valid JSON");
  }
  // Reject any issuer-stamped JWT (e.g. an OAuth access token, iss="memex-oauth")
  // replayed as a session token. Session tokens never carry `iss`; verifyAccessToken
  // enforces the mirror check, so this closes the reverse-replay direction (b-31 dec-3).
  if ((claims as { iss?: unknown }).iss !== undefined) {
    throw new InvalidTokenError("unexpected issuer");
  }
  if (typeof claims.sub !== "string" || !claims.sub) throw new InvalidTokenError("missing sub");
  if (typeof claims.exp !== "number") throw new InvalidTokenError("missing exp");

  const now = Math.floor(Date.now() / 1000);
  if (claims.exp < now) throw new InvalidTokenError("expired");

  return claims;
}

// Utility for generating opaque tokens (magic link, verification). Base64url of
// cryptographically-random bytes — 32 bytes = 256 bits, plenty for single-use.
export function generateOpaqueToken(byteLength = 32): string {
  return base64urlEncode(randomBytes(byteLength));
}

// ── Anonymous voice-guide session token (spec-222 t-10, dec-4 → ac-14) ─────────
//
// The PUBLIC voice guide (memex-website) has no login and no tenant — but the
// WS/SSE proxy still needs to know WHICH surface a connection is bound to, and
// must refuse anyone who didn't first hit POST /guide/v1/session. So /session
// mints a short-lived SIGNED token (HS256, same getSecret() as session tokens)
// that binds ONLY `{ surface, issued_at, nonce }` — NO user, NO tenant. The WS
// and SSE legs verify it in place of verifySessionToken/canReadMemex; the bound
// surface drives retrieval + persona selection.
//
// The token carries kind:"guide-anon" so it is cryptographically distinct from a
// user session token: verifyAnonGuideToken REQUIRES that discriminator (a replayed
// session token has no `kind` → rejected) and verifySessionToken REQUIRES `sub`
// (an anon token has none → rejected). The two token families cannot be swapped.
//
// TTL is on the order of MINUTES: the token only has to survive the gap between
// minting and opening the WS/SSE. A short window bounds replay of a leaked token.

/** Default anon-guide token lifetime — minutes, not days (the connect window). */
const DEFAULT_ANON_GUIDE_TTL_SECONDS = 5 * 60; // 5 minutes
const ANON_GUIDE_KIND = "guide-anon" as const;

export interface AnonGuideClaims {
  /** Discriminator pinning this as an anon-guide token (never a session token). */
  kind: typeof ANON_GUIDE_KIND;
  /** The product surface this anonymous session is bound to (server-validated). */
  surface: string;
  /** Random nonce so two tokens minted in the same second still differ. */
  nonce: string;
  /** Issued-at (seconds since epoch). */
  iat: number;
  /** Expires-at (seconds since epoch). */
  exp: number;
}

/**
 * Mint a short-lived signed anonymous guide-session token bound to `surface`.
 * The caller (routes/guide-public.ts) validates `surface` via assertGuideSurface
 * BEFORE calling this — this function just signs whatever surface it's handed.
 * Returns the token plus its absolute expiry (seconds since epoch) so the route
 * can hand the client an `expiresAt`.
 */
export function signAnonGuideToken(
  surface: string,
  ttlSeconds = DEFAULT_ANON_GUIDE_TTL_SECONDS,
): { token: string; expiresAt: number } {
  const now = Math.floor(Date.now() / 1000);
  const exp = now + ttlSeconds;
  const header = { alg: "HS256", typ: "JWT" };
  const payload: AnonGuideClaims = {
    kind: ANON_GUIDE_KIND,
    surface,
    nonce: generateOpaqueToken(16),
    iat: now,
    exp,
  };

  const encodedHeader = base64urlEncode(JSON.stringify(header));
  const encodedPayload = base64urlEncode(JSON.stringify(payload));
  const signingInput = `${encodedHeader}.${encodedPayload}`;

  const signature = createHmac("sha256", getSecret()).update(signingInput).digest();
  const encodedSignature = base64urlEncode(signature);

  return { token: `${signingInput}.${encodedSignature}`, expiresAt: exp };
}

/**
 * Verify an anonymous guide-session token. Mirrors verifySessionToken's HS256 +
 * constant-time signature check, but enforces the kind:"guide-anon" discriminator
 * and forbids `sub` (so a user session token can never be replayed here). Throws
 * {@link InvalidTokenError} on any failure — the caller maps every failure to the
 * SAME opaque denial (WS 1008 / SSE refuse) without leaking the reason (std-7).
 */
export function verifyAnonGuideToken(token: string): AnonGuideClaims {
  const parts = token.split(".");
  if (parts.length !== 3) throw new InvalidTokenError("malformed");

  const [encodedHeader, encodedPayload, encodedSignature] = parts;
  const signingInput = `${encodedHeader}.${encodedPayload}`;

  const expected = createHmac("sha256", getSecret()).update(signingInput).digest();
  const actual = base64urlDecode(encodedSignature);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    throw new InvalidTokenError("signature mismatch");
  }

  let claims: AnonGuideClaims & { sub?: unknown };
  try {
    claims = JSON.parse(base64urlDecode(encodedPayload).toString("utf8"));
  } catch {
    throw new InvalidTokenError("payload not valid JSON");
  }
  // A user session token (carries `sub`, no `kind`) must NOT be accepted here.
  if (claims.kind !== ANON_GUIDE_KIND) throw new InvalidTokenError("wrong token kind");
  if (claims.sub !== undefined) throw new InvalidTokenError("unexpected subject");
  if (typeof claims.surface !== "string" || !claims.surface) {
    throw new InvalidTokenError("missing surface");
  }
  if (typeof claims.nonce !== "string" || !claims.nonce) {
    throw new InvalidTokenError("missing nonce");
  }
  if (typeof claims.exp !== "number") throw new InvalidTokenError("missing exp");

  const now = Math.floor(Date.now() / 1000);
  if (claims.exp < now) throw new InvalidTokenError("expired");

  return claims;
}

// Pulse (b-60). Derive a stable, opaque session identifier from a request's
// Authorization header for use as the `clientId` on rest_ui activity events.
//
// The raw session token (HS256 JWT) is a credential and MUST NOT leave the auth
// boundary — so we never surface it directly. Instead we hash the token's
// signature segment (the part that's already a one-way HMAC over header+payload)
// into a short, non-reversible id that is stable for the life of one session.
// Two requests carrying the same token map to the same clientId; logging out and
// back in mints a new one. Returns null when no bearer token is present (e.g.
// the dev-user fallback path) so the caller can choose its own attribution.
export function sessionIdFromAuthHeader(authHeader: string | undefined | null): string | null {
  if (!authHeader || !authHeader.startsWith("Bearer ")) return null;
  const token = authHeader.slice(7).trim();
  if (!token) return null;
  const parts = token.split(".");
  // Hash the whole token so a malformed/non-JWT bearer still yields a stable id.
  const material = parts.length === 3 ? parts[2] : token;
  // sha256 → hex, truncated to 16 chars (64 bits). Opaque, collision-safe enough
  // for de-dupe/attribution, and reveals nothing about the underlying token.
  return createHmac("sha256", "memex-pulse-session-id").update(material).digest("hex").slice(0, 16);
}
