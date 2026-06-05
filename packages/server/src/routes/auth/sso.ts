import { Hono } from "hono";
import {
  handleSsoLogin,
  MemexAccessError,
  DisabledUserError,
  type SsoTokenPayload,
} from "../../services/auth.js";
import { markEmailVerified } from "../../services/users.js";
import type { MemexResolverEnv } from "../../middleware/memex-resolver.js";
import type { SessionEnv } from "../../middleware/session.js";
import { readJsonBody, requireString } from "../validation.js";
import {
  oauthClient,
  googleClientId,
  DEV_USER_EMAIL,
  withToken,
} from "./helpers.js";

export const sso = new Hono<MemexResolverEnv & SessionEnv>();

// POST /api/auth/sso/google
// Body: { idToken: string, memexId?: string }
// Public (no session middleware) — this is the entry point that creates the session.
sso.post("/google", async (c) => {
  const body = await readJsonBody<{ idToken?: unknown; memexId?: string }>(c);
  const requestedAccountId: string | null = body?.memexId ?? null;

  let payload: SsoTokenPayload;

  if (!oauthClient) {
    // Dev mode — no OAuth verification possible
    payload = { email: DEV_USER_EMAIL };
  } else {
    const idToken = requireString(body?.idToken, "idToken");
    try {
      const ticket = await oauthClient.verifyIdToken({
        idToken,
        audience: googleClientId!,
      });
      const tokenPayload = ticket.getPayload();
      if (!tokenPayload?.email) {
        return c.json({ error: "Invalid token payload" }, 401);
      }
      // Per dec-13, SSO is the source of email-verification truth. Reject tokens where
      // Google explicitly says the email isn't verified (rare for Workspace, possible for
      // some Gmail flows). Treats `undefined` as verified to avoid blocking legitimate logins
      // when the claim is omitted by the IDP.
      if (tokenPayload.email_verified === false) {
        return c.json(
          {
            error: "Email not verified",
            message: "Verify your email with your identity provider before signing in.",
          },
          403
        );
      }
      payload = {
        email: tokenPayload.email,
        hd: tokenPayload.hd,
      };
    } catch {
      return c.json({ error: "Invalid or expired token" }, 401);
    }
  }

  try {
    let session = await handleSsoLogin(payload, requestedAccountId);

    // If Google asserts the email is verified AND we haven't already stamped it, mirror
    // that into users.email_verified_at so the user skips our verification gate.
    if (!session.user.emailVerified) {
      await markEmailVerified(session.user.id);
      session = { ...session, user: { ...session.user, emailVerified: true } };
    }

    // Tenant override (t-7): if the request hostname resolves to an account the user is a
    // member of, surface that as currentMemexId so the bootstrap reflects "where they are".
    // Skipped silently when the user isn't a member — the client will detect and redirect.
    if (!requestedAccountId) {
      const tenantMemex = c.get("memex");
      if (tenantMemex) {
        const match = session.memberships.find((m) => m.memexId === tenantMemex.id);
        if (match) {
          session = { ...session, currentMemexId: match.memexId, currentRole: match.role };
        }
      }
    }
    return c.json(withToken(session));
  } catch (err) {
    if (err instanceof DisabledUserError) {
      return c.json({ error: "User is disabled" }, 403);
    }
    if (err instanceof MemexAccessError) {
      return c.json({ error: "Forbidden", message: err.message }, 403);
    }
    throw err;
  }
});
