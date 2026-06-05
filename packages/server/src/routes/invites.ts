import { Hono } from "hono";
import { createMiddleware } from "hono/factory";
import { sessionMiddleware, type SessionEnv } from "../middleware/session.js";
import { eq } from "drizzle-orm";
import { db } from "../db/connection.js";
import { memexes, namespaces } from "../db/schema.js";
import {
  createInviteToken,
  listActiveInvitesForAccount,
  revokeInviteToken,
  InviteTokenError,
} from "../services/invite-tokens.js";
import { getMemexById } from "../services/memexes.js";
import { joinExistingOrg, NoMemexAvailableError } from "../services/auth.js";
import { requireMemexId } from "./shared.js";

// Returns 'personal' for memexes whose namespace is user-owned, 'team' for org-owned.
async function memexKind(memexId: string): Promise<"personal" | "team" | null> {
  const memex = await db.query.memexes.findFirst({ where: eq(memexes.id, memexId) });
  if (!memex) return null;
  const ns = await db.query.namespaces.findFirst({ where: eq(namespaces.id, memex.namespaceId) });
  if (!ns) return null;
  return ns.kind === "user" ? "personal" : "team";
}

// Resolve the memex's owning org id (for invite_tokens.org_id), or null if the memex's
// namespace isn't org-owned.
async function memexOrgId(memexId: string): Promise<string | null> {
  const memex = await db.query.memexes.findFirst({ where: eq(memexes.id, memexId) });
  if (!memex) return null;
  const ns = await db.query.namespaces.findFirst({ where: eq(namespaces.id, memex.namespaceId) });
  return ns?.ownerOrgId ?? null;
}

// Public-ish invite-accept surface. The token IS the authorization (the caller
// doesn't need a tenant context yet — accepting the invite is what GRANTS the
// tenant context). So this router stays mounted flat at /api/invites/accept and
// is NOT covered by the path-prefix mount below.
//
// Bug-fix (t-XX of doc-15 drift sweep): the previous shared `invitesRouter` mixed
// flat-mountable accept with tenancy-scoped mint/list/revoke. The latter three
// universally 400-ed on the flat `/api/invites` mount because `currentMemexId` is
// set only by `memexResolver` for `/api/<ns>/<mx>/...` URLs. Splitting the router
// in two lets the accept stay flat (correct) and lets the admin trio mount under
// the tenant prefix (where the resolver actually populates the ctx).
export const invitesAcceptRouter = new Hono<SessionEnv>();
invitesAcceptRouter.use("/*", sessionMiddleware);

// POST /api/invites/accept — consume an invite token to join an org.
// Body: { token: string }
invitesAcceptRouter.post("/accept", async (c) => {
  const user = c.get("user");
  const body = await c.req.json().catch(() => ({}));
  const rawToken: unknown = body?.token;
  const token = typeof rawToken === "string" && rawToken.trim() ? rawToken.trim() : null;

  try {
    const { session } = await joinExistingOrg(user.id, user.email, token);
    return c.json(session);
  } catch (err) {
    if (err instanceof InviteTokenError) {
      return c.json({ error: "Invalid invite", reason: err.reason, message: err.message }, 400);
    }
    if (err instanceof NoMemexAvailableError) {
      return c.json({ error: "No memex available", message: err.message }, 404);
    }
    throw err;
  }
});

// Tenancy-scoped invite admin surface (mint/list/revoke). Mounted at
// /api/<ns>/<mx>/invites so memexResolver supplies currentMemexId before
// these handlers run. All three endpoints require active org membership of
// the resolved memex (enforced via the team-member gate below).
export const invitesAdminRouter = new Hono<SessionEnv>();
invitesAdminRouter.use("/*", sessionMiddleware);

const teamMemberGate = createMiddleware<SessionEnv>(async (c, next) => {
  const memexId = c.get("currentMemexId");
  if (!memexId) return c.json({ error: "Memex context required" }, 400);

  if (!(await getMemexById(memexId))) {
    return c.json({ error: "Memex not found" }, 404);
  }
  const kind = await memexKind(memexId);
  if (kind === "personal") {
    return c.json({ error: "Invites are not available on Personal Memexes" }, 400);
  }
  return next();
});

// POST /api/<ns>/<mx>/invites — creates a new invite token for the current memex.
invitesAdminRouter.post("/", teamMemberGate, async (c) => {
  const memexId = requireMemexId(c);
  const orgId = await memexOrgId(memexId);
  if (!orgId) return c.json({ error: "Org not found for this Memex" }, 400);
  const invite = await createInviteToken(orgId);
  return c.json(invite, 201);
});

// GET /api/<ns>/<mx>/invites — lists active (not revoked, not expired) invites for the current memex.
invitesAdminRouter.get("/", teamMemberGate, async (c) => {
  const memexId = requireMemexId(c);
  const orgId = await memexOrgId(memexId);
  if (!orgId) return c.json([]);
  const invites = await listActiveInvitesForAccount(orgId);
  return c.json(invites);
});

// DELETE /api/<ns>/<mx>/invites/:id — revokes an invite (stamps revoked_at) so the link stops working.
invitesAdminRouter.delete("/:id", teamMemberGate, async (c) => {
  const memexId = requireMemexId(c);
  const orgId = await memexOrgId(memexId);
  if (!orgId) return c.json({ error: "Invite not found" }, 404);
  const id = c.req.param("id");
  const result = await revokeInviteToken(id, orgId);
  if (!result) return c.json({ error: "Invite not found" }, 404);
  return c.json(result);
});

// Back-compat for the existing integration test fixture (invites.integration.test.ts)
// which mounts a single `/api/invites` router and exercises both the accept path
// and the mint/list/revoke trio under that mount. The test bypasses memexResolver
// entirely; sessionMiddleware's single-membership inference supplies the memex.
// In production, app.ts mounts the two routers above at their separate paths.
const invitesRouter = new Hono<SessionEnv>();
invitesRouter.route("/", invitesAcceptRouter);
invitesRouter.route("/", invitesAdminRouter);
export { invitesRouter };
