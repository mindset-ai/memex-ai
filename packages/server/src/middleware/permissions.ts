// Permission gates shared across route modules.
//
// adminGate — used by tenancy-scoped routes that require the caller to be an
// administrator of the current org. Resolves via currentMemexId + currentRole
// stamped by sessionMiddleware (which gets currentMemexId from memexResolver).
//
// namespaceAccessGate — used by routes mounted under /api/namespaces/:namespaceId.
// Resolves the namespace, checks the caller's access, and stamps
// currentNamespace + currentOrgId (org variant) + currentNamespaceRole on the
// context. 404 for unknown namespaces and for non-members / non-owners (per
// std-7 — no enumeration leak).

import { eq } from "drizzle-orm";
import { createMiddleware } from "hono/factory";
import { db } from "../db/connection.js";
import { namespaces, orgMemberships } from "../db/schema.js";
import type { SessionEnv } from "./session.js";

export const adminGate = createMiddleware<SessionEnv>(async (c, next) => {
  const memexId = c.get("currentMemexId");
  const role = c.get("currentRole");
  if (!memexId) {
    // b-38 F-6 — when sessionMiddleware stamped availableMemexes (user has
    // multiple memberships, no path memex), surface a structured 409 with
    // the list so the React UI can render the workspace picker directly
    // rather than showing a cryptic 400 and waiting for a /me/namespaces
    // fetch. Falls back to the generic 400 when truly no memberships exist.
    const availableMemexes = c.get("availableMemexes");
    if (availableMemexes && availableMemexes.length > 1) {
      return c.json(
        {
          error: "Multiple Memexes available — pick a workspace",
          availableMemexes,
        },
        409,
      );
    }
    return c.json({ error: "Memex context required" }, 400);
  }
  if (role !== "administrator") return c.json({ error: "Not found" }, 404);
  return next();
});

export const namespaceAccessGate = createMiddleware<SessionEnv>(async (c, next) => {
  const namespaceId = c.req.param("namespaceId");
  if (!namespaceId) return c.json({ error: "namespaceId is required" }, 404);

  const ns = await db.query.namespaces.findFirst({ where: eq(namespaces.id, namespaceId) });
  if (!ns) return c.json({ error: "Namespace not found" }, 404);

  const user = c.get("user");

  if (ns.kind === "org") {
    if (!ns.ownerOrgId) return c.json({ error: "Namespace has no owning org" }, 403);
    const membership = await db.query.orgMemberships.findFirst({
      where: (m, { and, eq }) =>
        and(
          eq(m.userId, user.id),
          eq(m.orgId, ns.ownerOrgId!),
          eq(m.status, "active"),
        ),
    });
    if (!membership) return c.json({ error: "Namespace not found" }, 404);
    c.set("currentNamespace", ns);
    c.set("currentOrgId", ns.ownerOrgId);
    c.set("currentNamespaceRole", membership.role as "member" | "administrator");
  } else {
    // kind === 'user'
    if (ns.ownerUserId !== user.id) return c.json({ error: "Namespace not found" }, 404);
    c.set("currentNamespace", ns);
  }
  return next();
});
