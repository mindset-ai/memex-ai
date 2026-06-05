// Shared infrastructure for the auth/* sub-routers. Kept in its own module so each
// sub-router file (sso, password, magic-link, reset, session) can import the same
// rate-limit/IP/token-attachment helpers without circular dependencies.

import type { Context } from "hono";
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
