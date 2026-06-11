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
import { getCookie } from "hono/cookie";
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
