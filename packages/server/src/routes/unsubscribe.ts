import { Hono } from "hono";
import { verifyUnsubscribeToken } from "../services/email/unsubscribe-token.js";
import { markLifecycleEmailUnsubscribed } from "../services/users.js";

// spec-427 t-4 (dec-5) — the PUBLIC lifecycle-email unsubscribe endpoint. No session
// or tenant middleware (mounted flat, like /api/share and /api/stripe/webhook): the
// HMAC token IS the capability. Mail clients POST one-click cross-origin with no
// session and no CSRF token, so this route deliberately sits outside any auth/CSRF
// guard — the token proves the request.
//
// RFC 8058: the token lives in the query string for BOTH verbs. A GET is the human
// clicking the in-body link (a mail-client link scanner may prefetch it — that
// auto-unsubscribes, which is acceptable and spec-mandated: there is no resubscribe
// path in scope). A POST with `List-Unsubscribe=One-Click` in the body is the
// one-click header path (Gmail/Apple Mail); we still read the token from ?token=.
const unsubscribeRouter = new Hono();

// Minimal inline confirmation pages — no imagery, no external assets.
const OK_PAGE =
  "<!doctype html><meta charset=utf-8><title>Unsubscribed</title>" +
  "<body style=\"font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem;color:#0E1128\">" +
  "<h1>You're unsubscribed</h1><p>You won't receive any more activation or product-update " +
  "emails from Memex AI. Account and security emails (sign-in links, password resets) still send. " +
  "Changed your mind? Just reply to any Memex email.</p></body>";
const BAD_PAGE =
  "<!doctype html><meta charset=utf-8><title>Invalid link</title>" +
  "<body style=\"font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem;color:#0E1128\">" +
  "<h1>This link isn't valid</h1><p>The unsubscribe link is malformed or incomplete. " +
  "If you keep getting emails you don't want, reply to any Memex email and we'll sort it.</p></body>";

// Resolve the token and record the suppression. Idempotent (markLifecycleEmailUnsubscribed
// only stamps a still-null row). Returns true when a valid token was applied.
async function applyUnsubscribe(token: string | undefined): Promise<boolean> {
  const userId = verifyUnsubscribeToken(token);
  if (!userId) return false;
  await markLifecycleEmailUnsubscribed(userId);
  return true;
}

unsubscribeRouter.get("/unsubscribe", async (c) => {
  const ok = await applyUnsubscribe(c.req.query("token"));
  return c.html(ok ? OK_PAGE : BAD_PAGE, ok ? 200 : 400);
});

unsubscribeRouter.post("/unsubscribe", async (c) => {
  // RFC 8058: token is on the URL, not in the form body (which is List-Unsubscribe=One-Click).
  const ok = await applyUnsubscribe(c.req.query("token"));
  return c.body(null, ok ? 200 : 400);
});

export { unsubscribeRouter };
