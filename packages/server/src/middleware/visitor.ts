// visitorMiddleware — the server arm of the anonymous-first identity spine
// (spec-254 t-2). A PURE READER (dec-4 = B).
//
// It exposes the visitor_id that a CONSENTED client has already established —
// read from the .memex.ai first-party cookie, else an inbound ?aid= query param
// (the marketing handoff) — onto c.get("visitorId") for the merge (t-4) and the
// /telemetry stamp (t-2). It validates the value as a UUID and otherwise ignores
// it.
//
// It NEVER mints a visitor_id and NEVER sets a cookie. Under consent-gating the
// server cannot know consent state, so a server-side mint would bypass the gate
// (dec-4 = B): the client owns the consent-gated mint and the Set-Cookie. Advisory:
// any failure is swallowed so visitor resolution never blocks a request.

import { createMiddleware } from "hono/factory";
import type { Context } from "hono";
import { getCookie, deleteCookie } from "hono/cookie";
import { mergeVisitor } from "../services/visitors.js";
import type { SessionEnv } from "./session.js";

// The cookie the consented client sets (Domain=.memex.ai). Kept in lockstep with
// the client constant of the same name; the std-28 e2e journey catches drift.
export const VISITOR_COOKIE = "memex_vid";

// RFC-4122 UUID, any version, case-insensitive. A non-UUID cookie / ?aid (a forked
// or malicious client) is ignored rather than trusted.
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function asUuid(value: string | undefined | null): string | undefined {
  return typeof value === "string" && UUID_RE.test(value) ? value : undefined;
}

export const visitorMiddleware = createMiddleware<SessionEnv>(async (c, next) => {
  try {
    const fromCookie = asUuid(getCookie(c, VISITOR_COOKIE));
    const visitorId = fromCookie ?? asUuid(c.req.query("aid"));
    if (visitorId) c.set("visitorId", visitorId);
  } catch {
    // advisory — never block a request on visitor resolution
  }
  return next();
});

// Domain for the cross-property cookie. ".memex.ai" in deployed envs (so www + app
// share it); host-only (undefined) in local/dev/test where the host is localhost.
// Kept in lockstep with the client's cookie domain.
export function visitorCookieDomain(): string | undefined {
  const host = (process.env.APP_BASE_URL ?? "").toLowerCase();
  return host.includes("memex.ai") ? ".memex.ai" : undefined;
}

/**
 * The identify step (spec-254 t-4), called from each auth route after a session is
 * established. Reads the consented visitor_id from context and merges it into the
 * now-known user (the SCD identify). On the bind-once "rebind" outcome — the cookie
 * belongs to a DIFFERENT user (account churn on one browser) — it does NOT re-point
 * the binding (mergeVisitor already refused) and clears the cookie so the consented
 * client mints a fresh id for this user on next load. Advisory: never throws into
 * the auth flow; user_id comes from the authenticated session, never the client.
 */
export async function applyVisitorMerge(
  c: Context<SessionEnv>,
  userId: string,
): Promise<void> {
  const visitorId = c.get("visitorId");
  if (!visitorId) return;
  try {
    const outcome = await mergeVisitor(visitorId, userId);
    if (outcome?.status === "rebind") {
      deleteCookie(c, VISITOR_COOKIE, { domain: visitorCookieDomain(), path: "/" });
    }
  } catch {
    // advisory — the identify merge must never break sign-in
  }
}
