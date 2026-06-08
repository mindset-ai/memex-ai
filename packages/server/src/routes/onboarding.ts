// spec-206 — the first-run greeting gate for the Specky welcome.
//
// User-level (NOT memex-scoped): the flag lives on the users row (dec-3), so this
// router is mounted at /api/onboarding with no /<ns>/<mx>/ prefix. Both routes sit
// behind the STRICT sessionMiddleware, so an anonymous caller is 401'd before the
// handler runs and `currentUserId` / `user` are always present.
//
// GET  /api/onboarding/greeting  → { greet, firstName }
//     greet = the user has never been greeted (onboarding_greeted_at IS NULL).
//     firstName = first whitespace token of users.name, or null (dec-2; the client
//     renders a warm nameless fallback when null — ac-11). The client calls this on
//     board mount and only auto-starts Specky when greet === true (ac-1, ac-13).
//
// POST /api/onboarding/greeting  → { status: "ok" }
//     Stamps onboarding_greeted_at = now() for the current user (idempotent — first
//     greeting wins). The client calls this ONLY once Specky's opening turn actually
//     reaches `active` (dec-4), so a blocked/denied mic does not consume the one-shot
//     (ac-16). A second call (this or another device) is a no-op → never re-greeted
//     (ac-14).

import { Hono } from "hono";
import { sessionMiddleware, type SessionEnv } from "../middleware/session.js";
import { markOnboardingGreeted } from "../services/users.js";

const onboarding = new Hono<SessionEnv>();

// STRICT session policy — anonymous → 401 before any handler.
onboarding.use("/*", sessionMiddleware);

/** First whitespace-delimited token of a display name (dec-2 / ac-10), or null
 *  when there is no usable name (ac-11 — the client renders a warm fallback). */
export function deriveFirstName(name: string | null | undefined): string | null {
  const first = (name ?? "").trim().split(/\s+/)[0];
  return first ? first : null;
}

onboarding.get("/greeting", (c) => {
  const user = c.get("user");
  return c.json({
    greet: user.onboardingGreetedAt == null,
    firstName: deriveFirstName(user.name),
  });
});

onboarding.post("/greeting", async (c) => {
  const currentUserId = c.get("currentUserId") as string;
  await markOnboardingGreeted(currentUserId);
  return c.json({ status: "ok" });
});

export { onboarding };
