import { Hono } from "hono";
import type { Context } from "hono";
import { resolveSession } from "../../services/auth.js";
import { getUserByEmail, markEmailVerified, upsertUserByEmail } from "../../services/users.js";
import { ensureUserMemex } from "../../services/user-namespaces.js";
import { issueAuthToken, consumeAuthToken, AuthTokenError } from "../../services/auth-tokens.js";
import {
  createLoginRequest,
  getLoginRequestStatus,
  markLoginRequestVerified,
  deleteLoginRequest,
} from "../../services/login-requests.js";
import { getEmailSender } from "../../services/email/sender.js";
import { buildMagicLinkEmail } from "../../services/email/templates.js";
import { rateLimit, AUTH_LIMITS } from "../../services/auth-rate-limit.js";
import type { SessionEnv } from "../../middleware/session.js";
import type { MemexResolverEnv } from "../../middleware/memex-resolver.js";
import { readJsonBody, requireString } from "../validation.js";
import { APP_BASE_URL, setKnownCookie, withToken } from "./helpers.js";
import { applyVisitorMerge } from "../../middleware/visitor.js";

export const magicLink = new Hono<MemexResolverEnv & SessionEnv>();

// Builds the authenticated session payload for a magic-link sign-in, applying the tenant
// override (parity with sso.ts / password.ts login): when the request carries a resolved
// team memex the user belongs to, surface it as currentMemexId so the link clicked on a
// team subdomain lands them in that team rather than their personal memex. Shared by the
// /consume route and the originating-session /status poll so both return the same shape.
async function buildMagicLinkSession(
  c: Context<MemexResolverEnv & SessionEnv>,
  userId: string,
) {
  let session = await resolveSession(userId, null);
  const tenantMemex = c.get("memex");
  if (tenantMemex) {
    const match = session.memberships.find((m) => m.memexId === tenantMemex.id);
    if (match) {
      session = { ...session, currentMemexId: match.memexId, currentRole: match.role };
    }
  }
  return session;
}

// POST /api/auth/magic-link
// Body: { email }
// Sends a sign-in link to the given email. Always returns { ok: true, loginRequestId }
// (doesn't leak whether the email has an account). `loginRequestId` is an
// originating-session poll handle (spec-304): the requesting client (e.g. an embedded
// webview, whose cookie jar differs from where the link is clicked) polls
// GET /magic-link/login-requests/:id/status and becomes authenticated in-place once the
// link is consumed elsewhere. It is NOT the raw token — the raw token is emailed only.
// Rate-limited per email.
magicLink.post("/", async (c) => {
  const body = await readJsonBody<{ email?: unknown }>(c);
  const email = requireString(body?.email, "email");

  const rl = rateLimit("magicLink", email.toLowerCase(), AUTH_LIMITS.magicLink);
  if (!rl.ok) {
    return c.json(
      { error: "Too many magic link requests", retryAfterSec: rl.retryAfterSec },
      429
    );
  }

  // Always issue a token against the normalised email. If the user doesn't exist yet, the
  // consume endpoint will upsert them — magic-link doubles as signup.
  const existing = await getUserByEmail(email);
  const issued = await issueAuthToken({
    purpose: "magic_link",
    email,
    userId: existing?.id ?? null,
  });
  const loginUrl = `${APP_BASE_URL}/magic-link?token=${encodeURIComponent(issued.raw)}`;
  await getEmailSender()
    .send(buildMagicLinkEmail({ to: email, loginUrl }))
    .catch((err) => console.error("Failed to send magic link:", err));

  // Originating-session surrogate (spec-304): a poll handle the requesting client holds.
  // Same TTL as the token so the capability dies with it. Never leaks the raw token.
  const loginRequest = await createLoginRequest({
    tokenId: issued.row.id,
    email,
    expiresAt: issued.row.expiresAt,
  });

  return c.json({ ok: true, loginRequestId: loginRequest.id });
});

// POST /api/auth/magic-link/consume
// Body: { token }
// Consumes a magic-link token → upserts the user → stamps email_verified_at (clicking the
// link is proof of email ownership) → returns a session with a fresh JWT.
magicLink.post("/consume", async (c) => {
  const body = await readJsonBody<{ token?: unknown }>(c);
  const token = requireString(body?.token, "token");

  let row;
  try {
    row = await consumeAuthToken("magic_link", token);
  } catch (err) {
    if (err instanceof AuthTokenError) {
      return c.json({ error: "Invalid token", reason: err.reason, message: err.message }, 400);
    }
    throw err;
  }

  // Upsert the user (magic-link is also the signup path for new email-only users).
  const user = await upsertUserByEmail(row.email);
  await markEmailVerified(user.id);
  await ensureUserMemex(user.id);

  // Flip the originating-session surrogate (spec-304): stamps verifiedAt on the
  // login_requests row for this token, so the webview that requested the link picks up a
  // session on its next poll. Best-effort — a magic link issued before this feature shipped
  // (no surrogate row) consumes exactly as before.
  await markLoginRequestVerified(row.id);

  const session = await buildMagicLinkSession(c, user.id);
  setKnownCookie(c);
  await applyVisitorMerge(c, user.id); // spec-254 — identify merge (magic link / email-only signup)
  return c.json(withToken(session));
});

// GET /api/auth/magic-link/login-requests/:id/status
// UNAUTHENTICATED — the originating client (e.g. an embedded webview) isn't logged in yet;
// it holds only the loginRequestId from POST /magic-link and polls here. spec-304.
//   unknown id                 → 404
//   verified (and not expired) → 200 { verified: true, ...session } + the known-hint cookie
//                                (setKnownCookie), the SAME authenticated payload /consume returns, so
//                                the webview becomes logged in in-place. Single-shot: the
//                                surrogate is deleted after handing over the session, so the
//                                capability can't be replayed for a second session.
//   expired & not verified     → 200 { verified: false, expired: true }
//   not yet verified           → 200 { verified: false, expired: false }
magicLink.get("/login-requests/:id/status", async (c) => {
  const id = c.req.param("id");
  const row = await getLoginRequestStatus(id);
  if (!row) {
    return c.json({ error: "Unknown login request" }, 404);
  }

  const expired = row.expiresAt.getTime() < Date.now();

  if (!row.verifiedAt) {
    return c.json({ verified: false, expired });
  }

  // Verified — but a verified row whose TTL has lapsed must NOT mint a session (the
  // capability is dead). Treat it as expired rather than handing over auth.
  if (expired) {
    return c.json({ verified: false, expired: true });
  }

  // Claim the surrogate FIRST: the atomic DELETE ... RETURNING is the one-shot gate, not a
  // post-hoc cleanup. Under concurrent polling two requests can both read a verified row, so
  // gating session-mint on the read would hand out two sessions from one capability. Whichever
  // poll wins the delete (RETURNING a row) mints the session; the loser sees null and is told
  // the request is no longer pending — exactly one session per loginRequestId, even racing.
  const claimed = await deleteLoginRequest(row.id);
  if (!claimed) {
    return c.json({ verified: false, expired: false });
  }

  // The token was consumed → the user exists and email is verified. Resolve the user from the
  // claimed surrogate's email and return the same authenticated payload /consume returns. The
  // originating webview never held the raw token.
  const user = await getUserByEmail(claimed.email);
  if (!user) {
    // Should not happen (consume upserts before stamping verifiedAt), but never 500.
    return c.json({ verified: false, expired: false });
  }

  const session = await buildMagicLinkSession(c, user.id);

  setKnownCookie(c);
  return c.json({ verified: true, ...withToken(session) });
});
