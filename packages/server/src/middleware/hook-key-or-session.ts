// spec-300 issue-5 — hook-key-OR-session auth for the Skills WRITE verbs.
//
// A coding agent that holds only the checkout HOOK KEY (mxh_…, planted by
// `memex-ai install`) must be able to create/edit/delete Skills over REST — the
// same credential the checkout phone-home (routes/spec-checkout.ts) uses. The
// standard write policy (sessionMiddleware) accepts only a web-session JWT, so a
// hook-key holder would 401.
//
// This middleware is the WRITE-verb replacement for sessionMiddleware on the
// skills router. It offers hook-key auth as an ALTERNATIVE, never a replacement:
//
//   * Bearer looks like a hook key (mxh_…) → verify + authorize it. On success we
//     stamp the SAME session context the JWT path would (currentUserId /
//     currentMemexId / currentAccessLevel='write' / the user row) and wrap the
//     handler in runWithMemexId, exactly as sessionMiddleware does — then run the
//     route. An invalid / revoked / unauthorized hook key → 404 (std-7), matching
//     the session path's non-member posture.
//   * Any other Bearer (or none) → delegate to sessionMiddleware UNCHANGED, so the
//     web-session JWT flow is byte-identical to before.
//
// Authorization mirrors routes/spec-checkout.ts (spec-430 dec-1): a user-scoped
// key (memexId NULL) authorizes any Memex its creator is a member of; a legacy
// per-memex key is additionally pinned to its own memex. Membership is checked
// with the SAME isMemberOfMemex predicate the MCP layer gates on. The memex +
// namespace are already resolved onto the context by the global memexResolver
// (path-based, /api/:namespace/:memex/skills), and those lookups read the
// RLS-EXCLUDED control plane, so they run correctly before the runWithMemexId wrap.

import { createMiddleware } from "hono/factory";
import { runWithMemexId } from "../db/connection.js";
import { verifyHookKey, bumpHookKeyLastUsed, looksLikeHookKey } from "../services/hook-keys.js";
import { getUserById } from "../services/users.js";
import { isMemberOfMemex, type MemexResolverEnv } from "./memex-resolver.js";
import { sessionMiddleware, type SessionEnv } from "./session.js";

type Env = MemexResolverEnv & SessionEnv;

function readBearer(header: string | undefined): string {
  if (!header?.startsWith("Bearer ")) return "";
  return header.slice("Bearer ".length).trim();
}

export const hookKeyOrSession = createMiddleware<Env>(async (c, next) => {
  const raw = readBearer(c.req.header("Authorization"));

  // Not a hook key (a session JWT, an mxt_ PAT, or nothing) → the write policy is
  // unchanged: hand off to the strict session middleware verbatim.
  if (!raw || !looksLikeHookKey(raw)) {
    return sessionMiddleware(c, next);
  }

  const notFound = () => c.json({ error: "Not found" }, 404);

  const hookKey = await verifyHookKey(raw);
  if (!hookKey) return notFound();

  // memexResolver (global) has already resolved + attached the path memex/namespace,
  // or 404'd before we got here. Be defensive if either is missing.
  const mx = c.get("memex");
  const ns = c.get("namespace");
  if (!mx || !ns) return notFound();

  const actorUserId = hookKey.createdByUserId ?? null;
  // Scope: a user-scoped key (memexId NULL) authorizes any memex; a per-memex key
  // is pinned to its own. Membership is the real gate (std-4 / spec-430 dec-1).
  const scopeOk = hookKey.memexId === null || hookKey.memexId === mx.id;
  if (!actorUserId || !scopeOk || !(await isMemberOfMemex(actorUserId, mx, ns))) {
    return notFound();
  }

  const user = await getUserById(actorUserId);
  if (!user || user.status === "disabled") return notFound();

  // Stamp the SAME context the JWT path establishes, so requireWriteMemexId(c) and
  // restCtx(c) (actor attribution) behave identically. A hook key carries WRITE
  // access by construction — it is only ever minted by an authenticated member.
  c.set("user", user);
  c.set("currentUserId", user.id);
  c.set("currentMemexId", mx.id);
  c.set("currentRole", "member");
  c.set("currentAccessLevel", "write");

  bumpHookKeyLastUsed(hookKey.id);

  // Run the handler under RLS context (std-36), exactly as sessionMiddleware's tail
  // does. Single wrap — this middleware REPLACES sessionMiddleware on the hook path,
  // so there is no double-wrap.
  return runWithMemexId(mx.id, next);
});
