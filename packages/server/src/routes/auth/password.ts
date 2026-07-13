import { Hono } from "hono";
import { resolveSession } from "../../services/auth.js";
import {
  getUserById,
  getUserByEmail,
  createUserWithPassword,
  markEmailVerified,
} from "../../services/users.js";
import { parseAttributionCookie, saveAttribution, hashEmail } from "../../services/attribution.js";
import { fireAllConversions } from "../../services/conversion-apis.js";
import { ensureUserMemex } from "../../services/user-namespaces.js";
import { syncUserProfile } from "../../services/mixpanel-profile.js";
import { hashPassword, verifyPassword, validatePasswordStrength } from "../../services/passwords.js";
import { issueAuthToken, consumeAuthToken, AuthTokenError } from "../../services/auth-tokens.js";
import { getEmailSender } from "../../services/email/sender.js";
import { buildVerificationEmail } from "../../services/email/templates.js";
import { rateLimit, AUTH_LIMITS } from "../../services/auth-rate-limit.js";
import { sessionMiddleware, type SessionEnv } from "../../middleware/session.js";
import type { MemexResolverEnv } from "../../middleware/memex-resolver.js";
import { ValidationError } from "../../types/errors.js";
import { readJsonBody, requireString } from "../validation.js";
import { APP_BASE_URL, clientIp, setKnownCookie, withToken } from "./helpers.js";
import { applyVisitorMerge } from "../../middleware/visitor.js";

export const password = new Hono<MemexResolverEnv & SessionEnv>();

// POST /api/auth/signup
// Body: { email, password }
// Creates a new user with a password hash, sends a verification email, and returns a
// session with emailVerified=false. The client lets the user in but shows a banner /
// blocks sensitive actions until verification.
password.post("/signup", async (c) => {
  const ip = clientIp(c);
  const rl = await rateLimit("signup", ip, AUTH_LIMITS.signup);
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

  // Dispatch the verification email (fire-and-forget; the user is admitted immediately,
  // emailVerified=false, gated by a banner).
  //
  // spec-474 dec-6: `ensureUserMemex` below now only creates the namespace + Memex row
  // (one fast tx) — the heavy onboarding content seed (starter Spec + Standards + facets)
  // moved OFF this request onto the first-load readiness endpoint (POST /api/me/provision),
  // so the signup response is no longer delayed by seconds of seeding and the email is
  // never queued behind it. (Previously the seed was awaited here for Cloud Run CPU
  // reasons, which is exactly what caused the ~12s email delay + "Resend" duplicates.)
  //
  // Skipped when the email is already verified (e.g. the user was previously created via
  // Google SSO and is now adding a password).
  if (!user.emailVerifiedAt) {
    const issued = await issueAuthToken({
      purpose: "email_verification",
      email: user.email,
      userId: user.id,
    });
    const verifyUrl = `${APP_BASE_URL}/verify-email?token=${encodeURIComponent(issued.raw)}`;
    void getEmailSender()
      .send(buildVerificationEmail({ to: user.email, verifyUrl }))
      .catch((err) => console.error("Failed to send verification email:", err));
  }

  // Ensure the personal namespace + Memex row exist (fast, one tx). Idempotent — safe
  // even if createUserWithPassword returned a pre-existing SSO user. spec-474 dec-6: the
  // onboarding CONTENT seed is not here any more; the SPA drives it on first load.
  await ensureUserMemex(user.id);

  // spec-297 dec-7: set the user's Mixpanel profile (email_domain + org links) so
  // the Users tab is populated and internal users are filterable from day one.
  // Advisory + idempotent ($engage $set is an upsert); a no-op on self-hosted
  // instances with no MIXPANEL_TOKEN.
  void syncUserProfile(user.id);

  const session = await resolveSession(user.id, null);
  setKnownCookie(c);
  await applyVisitorMerge(c, user.id); // spec-254 — identify merge (signup)
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
  const rl = await rateLimit("probe", ip, AUTH_LIMITS.probe);
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

  const rl = await rateLimit("login", `${ip}|${email.toLowerCase()}`, AUTH_LIMITS.login);
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
  setKnownCookie(c);
  await applyVisitorMerge(c, user.id); // spec-254 — identify merge (login)
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

  const preVerifyUser = await getUserById(row.userId);
  const isNewAccount = !preVerifyUser?.emailVerifiedAt;

  await markEmailVerified(row.userId);

  let conversionEventId: string | null = null;
  if (isNewAccount) {
    const attribution = parseAttributionCookie(c.req.header("cookie"));
    if (attribution) {
      const eventId = await saveAttribution(row.userId, attribution).catch((err) => {
        console.error("[spec-21] failed to save attribution:", err instanceof Error ? err.message : String(err));
        return null;
      });
      if (eventId && preVerifyUser) {
        conversionEventId = eventId;
        fireAllConversions({
          email: preVerifyUser.email,
          hashedEmail: hashEmail(preVerifyUser.email),
          eventId,
          attribution,
          conversionDateTime: new Date().toISOString(),
        });
      }
    }
  }

  const session = await resolveSession(row.userId, null);
  setKnownCookie(c);
  await applyVisitorMerge(c, row.userId); // spec-254 — identify merge (email verification)
  return c.json({ ...withToken(session), isNewAccount, conversionEventId });
});

// POST /api/auth/resend-verification (authenticated)
// Re-sends the verification email for the current user. Rate-limited.
password.post("/resend-verification", sessionMiddleware, async (c) => {
  const user = c.get("user");
  if (user.emailVerifiedAt) {
    return c.json({ ok: true, alreadyVerified: true });
  }

  // Short cooldown (1 per 60s) — the primary guard against bursty resends. The button
  // has no visible cooldown client-side either (fixed in VerifyEmailGate), so an
  // impatient user could otherwise fire several sends in seconds. Checked BEFORE the
  // hourly cap so a blocked burst doesn't burn the hourly budget and the caller gets a
  // precise "wait N seconds" (retryAfterSec ≈ time left in the 60s window).
  const cooldown = await rateLimit(
    "resendVerificationCooldown",
    user.id,
    AUTH_LIMITS.resendVerificationCooldown
  );
  if (!cooldown.ok) {
    return c.json(
      { error: "Please wait before requesting another email", retryAfterSec: cooldown.retryAfterSec },
      429
    );
  }

  const rl = await rateLimit("resendVerification", user.id, AUTH_LIMITS.resendVerification);
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
