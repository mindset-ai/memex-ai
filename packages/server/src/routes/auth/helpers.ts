// Shared infrastructure for the auth/* sub-routers. Kept in its own module so each
// sub-router file (sso, password, magic-link, reset, session) can import the same
// rate-limit/IP/token-attachment helpers without circular dependencies.

import type { Context } from "hono";
import { setCookie } from "hono/cookie";
import { OAuth2Client } from "google-auth-library";
import { signSessionToken } from "../../services/auth-jwt.js";
import type { SessionPayload } from "../../services/auth.js";

export const googleClientId = process.env.GOOGLE_CLIENT_ID;
export const oauthClient = googleClientId ? new OAuth2Client(googleClientId) : null;

// Dev fallback: when GOOGLE_CLIENT_ID isn't set, accept any "idToken" as the dev user's
// email so local development without OAuth setup mirrors the existing dev-bypass.
export const DEV_USER_EMAIL = "dev@memex.ai";

export const APP_BASE_URL = process.env.APP_BASE_URL ?? "http://localhost:5173";

// Best-effort client IP for rate-limiting. Honors the standard proxy header stack used
// by Cloud Run + Cloudflare; falls back to "unknown" so the limiter still degrades to
// per-email scoping if headers are missing.
export function clientIp(c: Context): string {
  return (
    c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ||
    c.req.header("cf-connecting-ip") ||
    c.req.header("x-real-ip") ||
    "unknown"
  );
}

// Attaches a fresh server-issued JWT to the session payload. The client stores this as
// `memex-auth-token` and the session middleware verifies it on subsequent requests.
export function withToken(session: SessionPayload): SessionPayload {
  return { ...session, token: signSessionToken(session.user.id) };
}

// memex_known: a JS-readable hint cookie consumed by the marketing site (www.memex.ai)
// so it can render "Login" instead of "Signup" for visitors who have authenticated
// before (mindset-prod/memex-website spec-15). It is deliberately NOT a session/auth
// token: its value is the constant "1", it carries no identity, and nothing in this
// server may read it to make an authorization decision (spec-15 ac-4) — it is written
// here and never read back. Set on every successful auth alongside withToken().
//
// Domain scope: on a memex.ai host the cookie is pinned to Domain=.memex.ai so it is
// shared across the www/int/prod subdomains (the marketing site is a different host
// from the app). On any other host (local dev, previews) the Domain attribute is
// omitted — a Domain the browser can't match is silently dropped, which would break
// dev login — and Secure is relaxed so the cookie survives http://localhost.
export function setKnownCookie(c: Context): void {
  let host = "";
  try {
    host = new URL(process.env.APP_BASE_URL ?? APP_BASE_URL).hostname;
  } catch {
    host = "";
  }
  const onMemexDomain = host === "memex.ai" || host.endsWith(".memex.ai");
  setCookie(c, "memex_known", "1", {
    domain: onMemexDomain ? ".memex.ai" : undefined,
    path: "/",
    maxAge: 60 * 60 * 24 * 365, // ~1 year — the "returning user" hint persists (spec-15 dec-1)
    httpOnly: false, // the marketing site reads it from document.cookie
    secure: onMemexDomain,
    sameSite: "Lax",
  });
}
