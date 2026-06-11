import { Hono } from "hono";
import { resolveSession } from "../../services/auth.js";
import { getUserByEmail, markEmailVerified, upsertUserByEmail } from "../../services/users.js";
import { ensureUserMemex } from "../../services/user-namespaces.js";
import { issueAuthToken, consumeAuthToken, AuthTokenError } from "../../services/auth-tokens.js";
import { getEmailSender } from "../../services/email/sender.js";
import { buildMagicLinkEmail } from "../../services/email/templates.js";
import { rateLimit, AUTH_LIMITS } from "../../services/auth-rate-limit.js";
import type { SessionEnv } from "../../middleware/session.js";
import type { MemexResolverEnv } from "../../middleware/memex-resolver.js";
import { readJsonBody, requireString } from "../validation.js";
import { APP_BASE_URL, withToken } from "./helpers.js";
import { applyVisitorMerge } from "../../middleware/visitor.js";

export const magicLink = new Hono<MemexResolverEnv & SessionEnv>();

// POST /api/auth/magic-link
// Body: { email }
// Sends a sign-in link to the given email. Always returns { ok: true } (doesn't leak
// whether the email has an account). Rate-limited per email.
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

  return c.json({ ok: true });
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

  // Tenant override (parity with sso.ts / password.ts login): surface the URL's team account
  // as currentMemexId when the user is a member, so a magic-link clicked on a team subdomain
  // lands the user in that team rather than their personal memex.
  let session = await resolveSession(user.id, null);
  const tenantMemex = c.get("memex");
  if (tenantMemex) {
    const match = session.memberships.find((m) => m.memexId === tenantMemex.id);
    if (match) {
      session = { ...session, currentMemexId: match.memexId, currentRole: match.role };
    }
  }
  await applyVisitorMerge(c, user.id); // spec-254 — identify merge (magic link / email-only signup)
  return c.json(withToken(session));
});
