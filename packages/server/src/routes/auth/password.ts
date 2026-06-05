import { Hono } from "hono";
import { resolveSession } from "../../services/auth.js";
import {
  getUserByEmail,
  createUserWithPassword,
  markEmailVerified,
} from "../../services/users.js";
import { ensureUserMemex } from "../../services/user-namespaces.js";
import { hashPassword, verifyPassword, validatePasswordStrength } from "../../services/passwords.js";
import { issueAuthToken, consumeAuthToken, AuthTokenError } from "../../services/auth-tokens.js";
import { getEmailSender } from "../../services/email/sender.js";
import { buildVerificationEmail } from "../../services/email/templates.js";
import { rateLimit, AUTH_LIMITS } from "../../services/auth-rate-limit.js";
import { sessionMiddleware, type SessionEnv } from "../../middleware/session.js";
import type { MemexResolverEnv } from "../../middleware/memex-resolver.js";
import { ValidationError } from "../../types/errors.js";
import { readJsonBody, requireString } from "../validation.js";
import { APP_BASE_URL, clientIp, withToken } from "./helpers.js";

export const password = new Hono<MemexResolverEnv & SessionEnv>();

// POST /api/auth/signup
// Body: { email, password }
// Creates a new user with a password hash, sends a verification email, and returns a
// session with emailVerified=false. The client lets the user in but shows a banner /
// blocks sensitive actions until verification.
password.post("/signup", async (c) => {
  const ip = clientIp(c);
  const rl = rateLimit("signup", ip, AUTH_LIMITS.signup);
  if (!rl.ok) {
    return c.json(
      { error: "Too many signup attempts", retryAfterSec: rl.retryAfterSec },
      429
    );
  }

  const body = await readJsonBody<{ email?: unknown; password?: unknown }>(c);
  const email = requireString(body?.email, "email");
  const passwordStr = requireString(body?.password, "password");

  try {
    validatePasswordStrength(passwordStr);
  } catch (err) {
    if (err instanceof ValidationError) {
      return c.json({ error: "Invalid password", message: err.message }, 400);
    }
    throw err;
  }

  let passwordHash: string;
  try {
    passwordHash = await hashPassword(passwordStr);
  } catch (err) {
    if (err instanceof ValidationError) {
      return c.json({ error: "Invalid password", message: err.message }, 400);
    }
    throw err;
  }

  let user;
  try {
    user = await createUserWithPassword({ email, passwordHash });
  } catch (err) {
    if (err instanceof ValidationError) {
      return c.json({ error: "Account exists", message: err.message }, 409);
    }
    throw err;
  }

  // Provision the personal memex. Idempotent — safe even if createUserWithPassword was
  // called for a pre-existing SSO user (returning the same row).
  await ensureUserMemex(user.id);

  // Issue a verification token unless the email is already verified (e.g. the user was
  // previously created via Google SSO and is now adding a password).
  if (!user.emailVerifiedAt) {
    const issued = await issueAuthToken({
      purpose: "email_verification",
      email: user.email,
      userId: user.id,
    });
    const verifyUrl = `${APP_BASE_URL}/verify-email?token=${encodeURIComponent(issued.raw)}`;
    await getEmailSender()
      .send(buildVerificationEmail({ to: user.email, verifyUrl }))
      .catch((err) => console.error("Failed to send verification email:", err));
  }

  const session = await resolveSession(user.id, null);
  return c.json(withToken(session), 201);
});

// POST /api/auth/probe
// Body: { email }
// Returns { exists, hasPassword } so the identifier-first login UI can pick the right
// next screen (password vs magic-link vs new-account). Rate-limited per IP — this is
// account-enumerable by design (matches Linear/Notion/Vercel UX), but we cap the rate
// so it can't be ground through.
password.post("/probe", async (c) => {
  const ip = clientIp(c);
  const rl = rateLimit("probe", ip, AUTH_LIMITS.probe);
  if (!rl.ok) {
    return c.json(
      { error: "Too many probe attempts", retryAfterSec: rl.retryAfterSec },
      429
    );
  }
  const body = await readJsonBody<{ email?: unknown }>(c);
  const email = requireString(body?.email, "email");
  const user = await getUserByEmail(email);
  return c.json({
    exists: !!user,
    hasPassword: !!user?.passwordHash,
  });
});

// POST /api/auth/login
// Body: { email, password }
password.post("/login", async (c) => {
  const ip = clientIp(c);
  const body = await readJsonBody<{ email?: unknown; password?: unknown }>(c);
  const email = requireString(body?.email, "email");
  const passwordStr = requireString(body?.password, "password");

  const rl = rateLimit("login", `${ip}|${email.toLowerCase()}`, AUTH_LIMITS.login);
  if (!rl.ok) {
    return c.json(
      { error: "Too many login attempts", retryAfterSec: rl.retryAfterSec },
      429
    );
  }

  const user = await getUserByEmail(email);
  if (!user || !user.passwordHash) {
    // Uniform message — don't reveal whether the email exists.
    return c.json({ error: "Invalid email or password" }, 401);
  }

  const ok = await verifyPassword(passwordStr, user.passwordHash);
  if (!ok) {
    return c.json({ error: "Invalid email or password" }, 401);
  }

  if (user.status === "disabled") {
    return c.json({ error: "User is disabled" }, 403);
  }

  // Tenant override (parity with /api/auth/sso/google): if the request came in on a team
  // subdomain the user is a member of, surface that as currentMemexId so the client's
  // post-login state reflects "where the user actually is" instead of defaulting to personal.
  // Without this the user logs into acme.memex.ai and the session's currentMemexId points
  // at their personal memex — the UI still routes correctly via subdomain, but role checks
  // (admin-only menu items, etc.) surface as if they were in personal.
  let session = await resolveSession(user.id, null);
  const tenantMemex = c.get("memex");
  if (tenantMemex) {
    const match = session.memberships.find((m) => m.memexId === tenantMemex.id);
    if (match) {
      session = { ...session, currentMemexId: match.memexId, currentRole: match.role };
    }
  }
  return c.json(withToken(session));
});

// POST /api/auth/verify-email
// Body: { token }
// Consumes the email-verification token and stamps users.email_verified_at. Returns the
// refreshed session. Safe for unauthenticated callers — the token itself proves ownership.
password.post("/verify-email", async (c) => {
  const body = await readJsonBody<{ token?: unknown }>(c);
  const token = requireString(body?.token, "token");

  let row;
  try {
    row = await consumeAuthToken("email_verification", token);
  } catch (err) {
    if (err instanceof AuthTokenError) {
      return c.json({ error: "Invalid token", reason: err.reason, message: err.message }, 400);
    }
    throw err;
  }

  if (!row.userId) {
    return c.json({ error: "Token has no associated user" }, 400);
  }

  await markEmailVerified(row.userId);
  const session = await resolveSession(row.userId, null);
  return c.json(withToken(session));
});

// POST /api/auth/resend-verification (authenticated)
// Re-sends the verification email for the current user. Rate-limited.
password.post("/resend-verification", sessionMiddleware, async (c) => {
  const user = c.get("user");
  if (user.emailVerifiedAt) {
    return c.json({ ok: true, alreadyVerified: true });
  }

  const rl = rateLimit("resendVerification", user.id, AUTH_LIMITS.resendVerification);
  if (!rl.ok) {
    return c.json(
      { error: "Too many resend attempts", retryAfterSec: rl.retryAfterSec },
      429
    );
  }

  const issued = await issueAuthToken({
    purpose: "email_verification",
    email: user.email,
    userId: user.id,
  });
  const verifyUrl = `${APP_BASE_URL}/verify-email?token=${encodeURIComponent(issued.raw)}`;
  await getEmailSender()
    .send(buildVerificationEmail({ to: user.email, verifyUrl }))
    .catch((err) => console.error("Failed to send verification email:", err));

  return c.json({ ok: true });
});
