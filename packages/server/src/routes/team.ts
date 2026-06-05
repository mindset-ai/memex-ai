import { Hono } from "hono";
import { createMiddleware } from "hono/factory";
import { eq } from "drizzle-orm";
import { db } from "../db/connection.js";
import { memexes, namespaces } from "../db/schema.js";
import { sessionMiddleware, type SessionEnv } from "../middleware/session.js";
import { getMemexById } from "../services/memexes.js";
import { listOrgMembers } from "../services/users.js";
import { requireMemexId } from "./shared.js";

// Team-scoped, member-visible endpoints. Unlike /api/org/* (admin-only), these are
// accessible to any active team member — they power the in-header Team dialog where
// every member can see who's in the workspace.
export const teamRouter = new Hono<SessionEnv>();

teamRouter.use("/*", sessionMiddleware);

// Only active members of an org memex may reach these endpoints. sessionMiddleware has
// already proven active membership when currentMemexId is set; here we just reject
// personal memexes (no team concept) and stray bare-domain calls.
const teamMemberGate = createMiddleware<SessionEnv>(async (c, next) => {
  const memexId = c.get("currentMemexId");
  if (!memexId) return c.json({ error: "Memex context required" }, 400);
  if (!(await getMemexById(memexId))) {
    return c.json({ error: "Memex not found" }, 404);
  }
  // Walk memex → namespace to discriminate personal vs team.
  const memex = await db.query.memexes.findFirst({ where: eq(memexes.id, memexId) });
  if (!memex) return c.json({ error: "Memex not found" }, 404);
  const ns = await db.query.namespaces.findFirst({
    where: eq(namespaces.id, memex.namespaceId),
  });
  if (ns?.kind === "user") {
    return c.json({ error: "Team endpoints are not available on Personal Memexes" }, 400);
  }
  return next();
});

teamRouter.use("/*", teamMemberGate);

// GET /api/team/members — active members of the current team.
teamRouter.get("/members", async (c) => {
  const memexId = requireMemexId(c);
  const memex = await db.query.memexes.findFirst({ where: eq(memexes.id, memexId) });
  if (!memex) return c.json([]);
  const ns = await db.query.namespaces.findFirst({
    where: eq(namespaces.id, memex.namespaceId),
  });
  if (!ns?.ownerOrgId) return c.json([]);
  const all = await listOrgMembers(ns.ownerOrgId);
  const active = all
    .filter((m) => m.status === "active")
    .map(({ userId, email, role, joinedAt }) => ({ userId, email, role, joinedAt }));
  return c.json(active);
});
