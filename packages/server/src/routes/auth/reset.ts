import { Hono } from "hono";
import { resolveSession } from "../../services/auth.js";
import { getUserByEmail, setUserPasswordHash, markEmailVerified } from "../../services/users.js";
import { hashPassword, validatePasswordStrength } from "../../services/passwords.js";
import { issueAuthToken, consumeAuthToken, AuthTokenError } from "../../services/auth-tokens.js";
import { getEmailSender } from "../../services/email/sender.js";
import { buildPasswordResetEmail } from "../../services/email/templates.js";
import { rateLimit, AUTH_LIMITS } from "../../services/auth-rate-limit.js";
import type { SessionEnv } from "../../middleware/session.js";
import type { MemexResolverEnv } from "../../middleware/memex-resolver.js";
import { ValidationError } from "../../types/errors.js";
import { readJsonBody, requireString } from "../validation.js";
import { APP_BASE_URL, withToken } from "./helpers.js";

export const reset = new Hono<MemexResolverEnv & SessionEnv>();

// POST /api/auth/password-reset
// Body: { email }
// Sends a password-reset link. Same "always 200" behavior as magic-link to avoid leaking
// whether an email has an account.
reset.post("/", async (c) => {
  const body = await readJsonBody<{ email?: unknown }>(c);
  const email = requireString(body?.email, "email");

  const rl = rateLimit("passwordReset", email.toLowerCase(), AUTH_LIMITS.passwordReset);
  if (!rl.ok) {
    return c.json(
      { error: "Too many reset requests", retryAfterSec: rl.retryAfterSec },
      429
    );
  }

  const existing = await getUserByEmail(email);
  if (existing) {
    const issued = await issueAuthToken({
      purpose: "password_reset",
      email,
      userId: existing.id,
    });
    const resetUrl = `${APP_BASE_URL}/reset-password?token=${encodeURIComponent(issued.raw)}`;
    await getEmailSender()
      .send(buildPasswordResetEmail({ to: email, resetUrl }))
      .catch((err) => console.error("Failed to send password reset:", err));
  }

  return c.json({ ok: true });
});

// POST /api/auth/password-reset/confirm
// Body: { token, password }
reset.post("/confirm", async (c) => {
  const body = await readJsonBody<{ token?: unknown; password?: unknown }>(c);
  const token = requireString(body?.token, "token");
  const passwordStr = requireString(body?.password, "password");

  try {
    validatePasswordStrength(passwordStr);
  } catch (err) {
    if (err instanceof ValidationError) {
      return c.json({ error: "Invalid password", message: err.message }, 400);
    }
    throw err;
  }

  let row;
  try {
    row = await consumeAuthToken("password_reset", token);
  } catch (err) {
    if (err instanceof AuthTokenError) {
      return c.json({ error: "Invalid token", reason: err.reason, message: err.message }, 400);
    }
    throw err;
  }

  if (!row.userId) {
    return c.json({ error: "Token has no associated user" }, 400);
  }

  const passwordHash = await hashPassword(passwordStr);
  await setUserPasswordHash(row.userId, passwordHash);
  // Successfully resetting password from a link delivered to the user's inbox is also
  // proof of email ownership — stamp email_verified_at if not already set.
  await markEmailVerified(row.userId);

  const session = await resolveSession(row.userId, null);
  return c.json(withToken(session));
});
