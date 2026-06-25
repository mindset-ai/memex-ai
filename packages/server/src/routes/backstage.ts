import { Hono } from "hono";
import { sql, desc, eq, and } from "drizzle-orm";
import { db } from "../db/connection.js";
import { memexes, namespaces, orgs, orgMemberships, documents } from "../db/schema.js";
import { upsertUserByEmail } from "../services/users.js";
import { isDevMode } from "../middleware/session.js";

const DEV_USER_EMAIL = "dev@memex.ai";

const backstageRouter = new Hono();

// GET /api/backstage/accounts — returns every Memex with membership + doc counts so the
// backstage list can show useful context at a glance. Personal Memexes (user-owned
// namespaces) and team Memexes (org-owned namespaces) are both surfaced; org-membership
// counts apply only to team Memexes.
backstageRouter.get("/accounts", async (c) => {
  if (!isDevMode()) {
    return c.json(
      {
        error: "Backstage disabled",
        message:
          "Backstage is currently dev-mode-only. To enable in production, add a real auth check to backstage.ts.",
      },
      403,
    );
  }

  const rows = await db
    .select({
      id: memexes.id,
      name: memexes.name,
      slug: namespaces.slug,
      createdAt: memexes.createdAt,
      orgId: namespaces.ownerOrgId,
      domainVerified: orgs.domainVerified,
      autoGroupingEnabled: orgs.autoGroupingEnabled,
      memberCount: sql<number>`count(distinct ${orgMemberships.id}) filter (where ${orgMemberships.status} = 'active')`.mapWith(Number),
      docCount: sql<number>`count(distinct ${documents.id})`.mapWith(Number),
    })
    .from(memexes)
    .innerJoin(namespaces, eq(memexes.namespaceId, namespaces.id))
    .leftJoin(orgs, eq(orgs.id, namespaces.ownerOrgId))
    .leftJoin(
      orgMemberships,
      and(
        eq(orgMemberships.orgId, orgs.id),
        eq(orgMemberships.status, "active"),
      ),
    )
    .leftJoin(documents, eq(documents.memexId, memexes.id))
    .groupBy(memexes.id, namespaces.id, orgs.id)
    .orderBy(desc(memexes.createdAt));

  return c.json(rows);
});

// POST /api/backstage/accounts/:id/impersonate — grants dev@memex.ai administrator
// membership of the target memex's org so the subsequent tenant-subdomain navigation
// doesn't get bounced by the membership gate. For personal memexes, no-op (dev already
// resolves to its own personal memex).
backstageRouter.post("/accounts/:id/impersonate", async (c) => {
  if (!isDevMode()) {
    return c.json(
      {
        error: "Backstage disabled",
        message:
          "Backstage is currently dev-mode-only. To enable in production, add a real auth check to backstage.ts.",
      },
      403,
    );
  }

  const memexId = c.req.param("id");
  const memex = await db.query.memexes.findFirst({ where: eq(memexes.id, memexId) });
  if (!memex) {
    return c.json({ error: "Memex not found" }, 404);
  }
  const ns = await db.query.namespaces.findFirst({
    where: eq(namespaces.id, memex.namespaceId),
  });
  if (!ns) {
    return c.json({ error: "Memex namespace not found" }, 404);
  }

  const dev = await upsertUserByEmail(DEV_USER_EMAIL);

  // For org-owned memexes: ensure dev has an active admin org_membership.
  // For user-owned memexes: nothing to grant (membership is implicit via namespace ownership).
  if (ns.kind === "org" && ns.ownerOrgId) {
    await db
      .insert(orgMemberships)
      .values({ userId: dev.id, orgId: ns.ownerOrgId, role: "administrator" })
      .onConflictDoUpdate({
        target: [orgMemberships.userId, orgMemberships.orgId],
        set: { role: "administrator", status: "active" },
      });
  }

  return c.json({ memexId, slug: ns.slug });
});

export { backstageRouter };
