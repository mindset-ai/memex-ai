// spec-427 t-4 (dec-5) — the lifecycle-email unsubscribe token.
//
// A STABLE, verifiable, no-PII token embedded in every activation/win-back email's
// one-click List-Unsubscribe link. Deliberately stateless — an HMAC over the userId,
// NOT a stored/consumable token (auth_tokens style is for single-use links; this one
// is the same for every send to a user and never expires, so a stored token would be
// pure overhead). The userId is a UUID, not PII, and the URL carries no email address.
//
// The MAC reuses AUTH_JWT_SECRET via getSecret(), domain-separated with an "unsub:"
// prefix so an unsubscribe token can never be cross-used as (or forged from) a session
// JWT or any other AUTH_JWT_SECRET-signed artifact.

import { createHmac, timingSafeEqual } from "node:crypto";
import { getSecret } from "../auth-jwt.js";

// Domain separation — the MAC is over this prefix + the userId, so the signing input
// space never overlaps the session-JWT signing input (`header.payload`).
const DOMAIN = "unsub:";

function mac(userId: string): Buffer {
  return createHmac("sha256", getSecret()).update(DOMAIN + userId).digest();
}

/** Mint the stable unsubscribe token for a user: `b64url(userId).b64url(mac)`. */
export function mintUnsubscribeToken(userId: string): string {
  const user = Buffer.from(userId, "utf8").toString("base64url");
  return `${user}.${mac(userId).toString("base64url")}`;
}

/**
 * Verify a token and return the userId it authorises, or null if it is missing,
 * malformed, or the MAC doesn't match. NEVER throws — a bad token is a null, not an
 * error (the endpoint turns null into a 400). Length is guarded before timingSafeEqual,
 * which throws RangeError on unequal-length buffers.
 */
export function verifyUnsubscribeToken(token: string | undefined | null): string | null {
  if (!token || typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [encUser, encMac] = parts;

  let userId: string;
  let providedMac: Buffer;
  try {
    userId = Buffer.from(encUser, "base64url").toString("utf8");
    providedMac = Buffer.from(encMac, "base64url");
  } catch {
    return null;
  }
  if (!userId) return null;

  const expected = mac(userId);
  // timingSafeEqual throws on length mismatch — guard it (a truncated MAC is invalid).
  if (providedMac.length !== expected.length) return null;
  return timingSafeEqual(providedMac, expected) ? userId : null;
}

/**
 * The absolute one-click unsubscribe URL for a user, host derived from APP_BASE_URL
 * (dec-8: int → int.memex.ai, prod → memex.ai), never hardcoded. This is the value
 * that rides the RFC 8058 List-Unsubscribe header (t-3) on every lifecycle send.
 */
export function unsubscribeUrl(userId: string): string {
  const base = process.env.APP_BASE_URL ?? "https://memex.ai";
  return `${base}/api/email/unsubscribe?token=${encodeURIComponent(mintUnsubscribeToken(userId))}`;
}
