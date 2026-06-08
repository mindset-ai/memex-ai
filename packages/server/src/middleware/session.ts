import { createMiddleware } from "hono/factory";
import { eq, and, sql } from "drizzle-orm";
import { db } from "../db/connection.js";
import { memexes, namespaces, orgs, orgMemberships } from "../db/schema.js";
import { getUserByEmail, getUserById, listMemberships, upsertUserByEmail } from "../services/users.js";
import { ensureUserNamespace } from "../services/user-namespaces.js";
import { verifySessionToken, InvalidTokenError } from "../services/auth-jwt.js";
import type { User, Memex, Namespace } from "../db/schema.js";

export type SessionEnv = {
  Variables: {
    user: User;
    // spec-111 t-3 — the resolved caller identity for the request, or `null`
    // when this is an anonymous request on a permissive (public-read) route.
    //
    // This is the CLEAN SEAM the read gate (canReadMemex, t-2/t-5) consumes:
    // downstream authz reads `currentUserId` and, when it is null, must fall
    // through to the public-visibility check rather than assuming a member.
    //
    //   - sessionMiddleware (strict)    → always a non-null id (it 401s first).
    //   - publicSessionMiddleware (lax) → null for anonymous, the user's id
    //     when a valid Bearer token was presented.
    //
    // `user` is only set when `currentUserId` is non-null. On the permissive
    // path an anonymous request leaves `user` UNSET — callers that need the
    // full row must guard on `currentUserId !== null` (or `c.get("user")`
    // being defined) first.
    currentUserId: string | null;
    // Resolved memex id for the current request, or null if the user is in
    // multiple memexes and the request didn't say which one (std-5).
    currentMemexId: string | null;
    currentRole: "member" | "administrator" | null;
    // spec-199 t-5: "read" for visited/anonymous subscribers (user_memex_access
    // rows), "write" for real org members. Only "write" may request include=all
    // on SSE streams. Absent from the strict path until a membership is resolved.
    currentAccessLevel: "read" | "write" | null;
    // Set by memexResolver when the request URL carries a /<namespace>/<memex>/
    // prefix. Routes that need a memex without one in the URL must either be
    // entity-keyed (UUID lookup) or accept the std-5 ambiguity error.
    namespace?: Namespace | null;
    memex?: Memex | null;
    // b-38 F-6 — stamped by sessionMiddleware when the user has more than one
    // membership and no path-memex was provided. Lets downstream routes return
    // a structured 409 (instead of cryptic 400) so the UI can render the
    // workspace picker without a separate /api/me/namespaces round-trip.
    // Undefined when the user has exactly one membership (or the path picked
    // a specific memex).
    availableMemexes?: Awaited<ReturnType<typeof listMemberships>>;
    // Stamped by namespaceAccessGate (middleware/permissions.ts) when a route
    // gates on /:namespaceId. The resolved namespace plus, for org namespaces,
    // the caller's org id + role.
    currentNamespace?: Namespace;
    currentOrgId?: string;
    currentNamespaceRole?: "member" | "administrator";
  };
};

const DEV_USER_EMAIL = process.env.DEV_USER_EMAIL ?? "dev@memex.ai";

export async function resolveDevUser(): Promise<User> {
  const user = await upsertUserByEmail(DEV_USER_EMAIL);
  if (!user.namespaceId) {
    await ensureUserNamespace(user.id);
    const refreshed = await getUserById(user.id);
    return refreshed ?? user;
  }
  return user;
}

/**
 * Idempotently grants the local dev user administrator membership on any
 * org-kind namespace listed in DEV_ORG_NAMESPACES. Called from the
 * hardcoded-bearer code path in app.ts so the membership self-heals if a
 * test suite (or anything else) cascades it away.
 *
 * Only meaningful in local dev — caller must already gate on isDevMode().
 * Silently no-ops for any namespace slug that doesn't exist locally (e.g. a
 * fresh empty DB without a prod restore).
 */
const DEV_ORG_NAMESPACES = ["mindset-prod"] as const;
export async function ensureDevMemberships(userId: string): Promise<void> {
  for (const slug of DEV_ORG_NAMESPACES) {
    const [ns] = await db
      .select({ id: namespaces.id })
      .from(namespaces)
      .where(eq(namespaces.slug, slug))
      .limit(1);
    if (!ns) continue;
    const [org] = await db
      .select({ id: orgs.id })
      .from(orgs)
      .where(eq(orgs.namespaceId, ns.id))
      .limit(1);
    if (!org) continue;
    await db
      .insert(orgMemberships)
      .values({ userId, orgId: org.id, role: "administrator", status: "active" })
      .onConflictDoNothing();
  }
  // Suppress unused-import warning for drizzle helpers in case the loop body
  // is ever conditionally dead.
  void and; void sql;
}

// b-38 F-1 — the dev-user fallback runs when GOOGLE_CLIENT_ID is unset, so a single
// Secret Manager misconfig in prod would silently authenticate every visitor as
// dev@memex.ai. Mirrors the auth-jwt.ts:getSecret pattern: throw on first use in
// production when the required env is missing, otherwise return the dev flag.
export function isDevMode(): boolean {
  const missingClientId = !process.env.GOOGLE_CLIENT_ID;
  if (missingClientId && process.env.NODE_ENV === "production") {
    throw new Error(
      "GOOGLE_CLIENT_ID is required in production. Without it the session middleware " +
        "would fall back to the dev user, silently authenticating every visitor as " +
        "dev@memex.ai. Configure GOOGLE_CLIENT_ID via Secret Manager and redeploy.",
    );
  }
  return missingClientId;
}

// Outcome of attempting to resolve a Bearer token into a Memex user.
//   - { kind: "user" }      → a live, valid token resolved a user row.
//   - { kind: "anonymous" } → no token (or a malformed/expired/unknown one).
//                             The strict middleware turns this into a 401; the
//                             permissive middleware treats it as userId=null.
//   - { kind: "reject" }    → a hard failure that BOTH middlewares must honour
//                             (e.g. the prod dev-mode guard, or a disabled
//                             user once we have a token-bearing identity). The
//                             response is carried so the caller returns it.
type BearerResolution =
  | { kind: "user"; user: User }
  // No token, or a malformed / expired / unverifiable token. Truly anonymous.
  | { kind: "anonymous" }
  // A well-formed, valid token whose subject no longer exists (deleted user).
  // Strict path → 401 "Sign in again"; permissive path → treat as anonymous.
  | { kind: "userGone" }
  | { kind: "reject"; response: Response };

/**
 * Resolve the caller from the Authorization header WITHOUT deciding policy.
 *
 * Shared by sessionMiddleware (strict) and publicSessionMiddleware (lax). It
 * never short-circuits on "no/invalid token" — it reports `anonymous` and lets
 * each middleware apply its own policy (401 vs userId=null). This is the single
 * place the share.ts-style "token resolves identity, gate decides access"
 * split lives for session routes.
 */
async function resolveBearerUser(
  c: Parameters<Parameters<typeof createMiddleware<SessionEnv>>[0]>[0],
): Promise<BearerResolution> {
  // Evaluate the dev flag BEFORE any token work so the b-38 F-1 prod guard
  // (isDevMode() throws when GOOGLE_CLIENT_ID is missing in production) still
  // fires on every request; that throw propagates.
  const devMode = isDevMode();

  const authHeader = c.req.header("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    // No token presented: dev mode auto-logins as dev@memex.ai — same on both
    // strict and lax paths so local dev keeps working without a token.
    if (devMode) {
      return { kind: "user", user: await resolveDevUser() };
    }
    return { kind: "anonymous" };
  }
  const token = authHeader.slice(7);

  try {
    const claims = verifySessionToken(token);
    const user = await getUserById(claims.sub);
    if (!user) {
      // A well-formed token whose subject no longer exists. Strict path renders
      // this as a distinct 401 ("Sign in again"); permissive path treats it as
      // anonymous so a public read still proceeds. Dev mode falls back to the
      // dev user so a stale localStorage token never bricks local dev.
      if (devMode) {
        return { kind: "user", user: await resolveDevUser() };
      }
      return { kind: "userGone" };
    }
    // A valid presented token resolves THAT user — even in dev mode (spec-172
    // issue-1): the dev bypass is a fallback for token-less requests, not a
    // shadow over real identities. This is what lets the e2e stack (and any
    // local client) authenticate as a freshly signed-up native-auth user while
    // token-less requests keep resolving dev@memex.ai.
    return { kind: "user", user };
  } catch (err) {
    if (err instanceof InvalidTokenError) {
      // Malformed/expired token: dev mode keeps the no-token convenience
      // (fall back to the dev user); real mode reports anonymous.
      if (devMode) {
        return { kind: "user", user: await resolveDevUser() };
      }
      return { kind: "anonymous" };
    }
    throw err;
  }
}

/**
 * Finish setting up a resolved user on the context: disabled-check,
 * lazy-provision a personal namespace, then run std-5 memex resolution. Shared
 * tail of both middlewares. Returns an error Response to short-circuit, or
 * null to continue.
 */
async function establishUserSession(
  c: Parameters<Parameters<typeof createMiddleware<SessionEnv>>[0]>[0],
  resolvedUser: User,
): Promise<Response | null> {
  let user = resolvedUser;

  if (user.status === "disabled") {
    return c.json({ error: "User is disabled" }, 403);
  }

  // Lazy-provision a personal namespace + memex for any user who doesn't have
  // one yet. This still happens at session time so users land somewhere usable.
  if (!user.namespaceId) {
    await ensureUserNamespace(user.id);
    const refreshed = await getUserById(user.id);
    if (refreshed) user = refreshed;
  }

  c.set("user", user);
  c.set("currentUserId", user.id);

  // Memex resolution per std-5 — no silent default for multi-namespace users.
  // Resolution priority:
  //   1. memexResolver-set ctx.memex (path-based, /<namespace>/<memex>/...)
  //   2. If user has exactly ONE accessible memex, auto-resolve to it.
  //   3. Otherwise leave currentMemexId null. Routes that need a memex must
  //      then come from path-resolution or from an entity FK; ambiguous calls
  //      return a structured error per std-5.
  const pathMemex = c.get("memex");

  let chosen: { memexId: string; role: "member" | "administrator"; accessLevel: "read" | "write" } | null = null;
  if (pathMemex) {
    // Find the matching membership to capture role.
    const memberships = await listMemberships(user.id);
    const match = memberships.find((m) => m.memexId === pathMemex.id);
    if (!match) {
      // Per std-7: 404, not 403. Caller can't tell whether the memex doesn't
      // exist or they just can't see it.
      //
      // NOTE (spec-111): this is the STRICT-membership 404. On the permissive
      // path a non-member with a valid token reaches here too — for a PUBLIC
      // memex the read gate (canReadMemex, t-2/t-5) must run BEFORE this 404 so
      // public reads aren't blocked. publicSessionMiddleware therefore does NOT
      // run this membership-404 branch for a path memex; it leaves the memex
      // unresolved-by-membership and defers the visibility decision to the gate.
      return c.json({ error: "Not found" }, 404);
    }
    chosen = { memexId: match.memexId, role: match.role, accessLevel: match.accessLevel ?? "write" };
  } else {
    const memberships = await listMemberships(user.id);
    if (memberships.length === 1) {
      const only = memberships[0];
      chosen = { memexId: only.memexId, role: only.role, accessLevel: only.accessLevel ?? "write" };
    } else if (memberships.length > 1) {
      // b-38 F-6 — auto-resolve is ambiguous. Stamp the available memexes on
      // context so downstream routes can return a structured 409 (instead of
      // a cryptic 400) and the UI can render the picker inline. This was the
      // silent failure when a user previously had one membership and then
      // joined a second org mid-session.
      c.set("availableMemexes", memberships);
    }
    // Multi-namespace + no path prefix → leave currentMemexId null. The picker
    // route at /api/me/namespaces also returns the list for clients that
    // prefer the dedicated endpoint (per std-5).
  }

  c.set("currentMemexId", chosen?.memexId ?? null);
  c.set("currentRole", chosen?.role ?? null);
  c.set("currentAccessLevel", chosen?.accessLevel ?? null);
  return null;
}

export const sessionMiddleware = createMiddleware<SessionEnv>(async (c, next) => {
  const resolution = await resolveBearerUser(c);

  if (resolution.kind === "reject") {
    return resolution.response;
  }
  if (resolution.kind === "userGone") {
    // Valid token, but the subject no longer exists. Distinct 401 so the client
    // knows to re-authenticate rather than retry.
    return c.json({ error: "User not found", message: "Sign in again" }, 401);
  }
  if (resolution.kind === "anonymous") {
    // Strict policy: no usable identity → 401. (Preserves the existing
    // distinct messages for "missing header" vs "invalid/expired token".)
    const authHeader = c.req.header("Authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return c.json({ error: "Missing Authorization header" }, 401);
    }
    return c.json({ error: "Invalid or expired token" }, 401);
  }

  const short = await establishUserSession(c, resolution.user);
  if (short) return short;
  return next();
});

/**
 * spec-111 t-3 — permissive session layer for public-READ routes.
 *
 * Mirrors the /api/share/:token precedent (routes/share.ts): instead of
 * inventing a new auth mechanism, it REUSES the same Bearer→user resolution as
 * sessionMiddleware but, when no/invalid token is present, resolves
 * `currentUserId = null` and proceeds INSTEAD of returning 401. The downstream
 * read gate (canReadMemex, t-2/t-5) then decides:
 *
 *   - public memex  → anonymous (currentUserId null) is allowed to read.
 *   - private memex → the gate returns 404 (std-7), identical to non-existent.
 *
 * Contract for the read gate consuming this:
 *   - `currentUserId` is the seam. `null` ⇒ anonymous; a string ⇒ that user id.
 *   - When `currentUserId` is non-null, `user` / `currentMemexId` / `currentRole`
 *     are resolved exactly as in the strict middleware (a member browsing a
 *     public memex keeps full write context).
 *   - For a path memex where a TOKEN-BEARING caller is NOT a member, this
 *     middleware does NOT 404 — it leaves membership unresolved (currentMemexId
 *     null, user set) so the read gate can grant public read. The gate owns the
 *     private→404 decision; this layer only owns the userId=null resolution.
 *
 * This middleware must only be mounted on read routes. Write routes keep
 * sessionMiddleware (which 401s anonymous and 404s non-members), so an
 * anonymous request can never reach a mutation.
 */
export const publicSessionMiddleware = createMiddleware<SessionEnv>(async (c, next) => {
  const resolution = await resolveBearerUser(c);

  if (resolution.kind === "reject") {
    return resolution.response;
  }

  if (resolution.kind === "anonymous" || resolution.kind === "userGone") {
    // Permissive policy: no usable identity (no token, bad token, or a valid
    // token whose user is gone) → anonymous, NOT a 401. Stamp the seam the read
    // gate consumes and continue. `user` is intentionally left unset;
    // downstream must guard on `currentUserId !== null`.
    c.set("currentUserId", null);
    c.set("currentMemexId", null);
    c.set("currentRole", null);
    c.set("currentAccessLevel", null);
    return next();
  }

  // A valid token resolved a user. Establish the full session, but DON'T let a
  // path-memex non-membership 404 short-circuit a public read: catch that one
  // case and degrade to "authenticated but membership-unresolved" so the read
  // gate can still grant public access.
  if (resolution.user.status === "disabled") {
    // Disabled users are rejected on every path, public or not.
    return c.json({ error: "User is disabled" }, 403);
  }

  let user = resolution.user;
  if (!user.namespaceId) {
    await ensureUserNamespace(user.id);
    const refreshed = await getUserById(user.id);
    if (refreshed) user = refreshed;
  }
  c.set("user", user);
  c.set("currentUserId", user.id);

  const pathMemex = c.get("memex");
  const memberships = await listMemberships(user.id);

  if (pathMemex) {
    const match = memberships.find((m) => m.memexId === pathMemex.id);
    if (match) {
      c.set("currentMemexId", match.memexId);
      c.set("currentRole", match.role);
      c.set("currentAccessLevel", match.accessLevel ?? "write");
    } else {
      // Token-bearing non-member on a path memex. Do NOT 404 here — defer to
      // canReadMemex (t-2/t-5), which grants read on public memexes and 404s on
      // private ones (std-7). Leave membership-derived context null.
      c.set("currentMemexId", null);
      c.set("currentRole", null);
      c.set("currentAccessLevel", null);
    }
  } else {
    if (memberships.length === 1) {
      c.set("currentMemexId", memberships[0].memexId);
      c.set("currentRole", memberships[0].role);
      c.set("currentAccessLevel", memberships[0].accessLevel ?? "write");
    } else {
      if (memberships.length > 1) c.set("availableMemexes", memberships);
      c.set("currentMemexId", null);
      c.set("currentRole", null);
      c.set("currentAccessLevel", null);
    }
  }

  return next();
});

export { getUserByEmail };
