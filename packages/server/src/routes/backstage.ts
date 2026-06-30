import { Hono } from "hono";
import { sql, desc, eq, and, asc } from "drizzle-orm";
import { db } from "../db/connection.js";
import {
  memexes,
  namespaces,
  orgs,
  orgMemberships,
  documents,
  experiments,
  experimentVariants,
  experimentAssignments,
} from "../db/schema.js";
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

// GET /api/backstage/experiments — read-only A/B scoreboard (spec-426 ac-4). Returns,
// per experiment, each variant arm's tally: users assigned, succeeded / failed / pending,
// and the success rate — enough for an operator to judge "is B beating A".
//
// CROSS-TENANT read path. The experiments / experiment_variants / experiment_assignments
// tables are platform-global and user-keyed (NO memex_id) and deliberately EXCLUDED from
// RLS (schema.ts cluster after comms_log; migration 0116). They mirror the comms_log
// posture: isolation is enforced here by the isDevMode() / operator gate, not by tenant
// RLS. This route is the sanctioned Backstage read surface for them.
//
// Tallies count the ACTIVE assignment only (superseded_at IS NULL) — a reassignment
// supersedes the prior arm membership, so a user is tallied under their CURRENT arm. The
// verdict sweep (dec-1) stamps `outcome` inline on that active row, so we tally those
// decided booleans directly rather than computing analytics over a firehose.
backstageRouter.get("/experiments", async (c) => {
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

  // One row per (experiment, variant) with the four filtered counts. A LEFT JOIN keeps
  // experiments with no variants and variants with no assignments visible (count 0).
  const activeAssignment = sql`${experimentAssignments.supersededAt} IS NULL`;
  const rows = await db
    .select({
      experimentId: experiments.id,
      key: experiments.key,
      statement: experiments.statement,
      status: experiments.status,
      windowDays: experiments.windowDays,
      createdAt: experiments.createdAt,
      variantId: experimentVariants.id,
      variantKey: experimentVariants.key,
      label: experimentVariants.label,
      description: experimentVariants.description,
      isControl: experimentVariants.isControl,
      behaviour: experimentVariants.behaviour,
      assigned: sql<number>`count(${experimentAssignments.id}) filter (where ${activeAssignment})`.mapWith(Number),
      succeeded: sql<number>`count(${experimentAssignments.id}) filter (where ${activeAssignment} and ${experimentAssignments.outcome} = 'succeeded')`.mapWith(Number),
      failed: sql<number>`count(${experimentAssignments.id}) filter (where ${activeAssignment} and ${experimentAssignments.outcome} = 'failed')`.mapWith(Number),
      pending: sql<number>`count(${experimentAssignments.id}) filter (where ${activeAssignment} and ${experimentAssignments.outcome} = 'pending')`.mapWith(Number),
    })
    .from(experiments)
    .leftJoin(experimentVariants, eq(experimentVariants.experimentId, experiments.id))
    .leftJoin(
      experimentAssignments,
      eq(experimentAssignments.variantId, experimentVariants.id),
    )
    .groupBy(experiments.id, experimentVariants.id)
    .orderBy(desc(experiments.createdAt), asc(experimentVariants.key));

  // Fold the flat (experiment, variant) rows into one object per experiment with a
  // `variants` array. success rate is over DECIDED assignments (succeeded + failed) —
  // pending users haven't reached the window yet, so folding them in would understate a
  // winning arm. null when nothing is decided yet (avoids a misleading 0%).
  type VariantTally = {
    variantId: string;
    key: string;
    label: string;
    description: string | null;
    isControl: boolean;
    behaviour: string;
    assigned: number;
    succeeded: number;
    failed: number;
    pending: number;
    successRate: number | null;
  };
  const byExperiment = new Map<
    string,
    {
      experimentId: string;
      key: string;
      statement: string;
      status: string;
      windowDays: number;
      createdAt: Date | string;
      variants: VariantTally[];
    }
  >();

  for (const r of rows) {
    let exp = byExperiment.get(r.experimentId);
    if (!exp) {
      exp = {
        experimentId: r.experimentId,
        key: r.key,
        statement: r.statement,
        status: r.status,
        windowDays: r.windowDays,
        createdAt: r.createdAt,
        variants: [],
      };
      byExperiment.set(r.experimentId, exp);
    }
    // variantId is null for an experiment with no variants (LEFT JOIN miss).
    if (r.variantId) {
      const decided = r.succeeded + r.failed;
      exp.variants.push({
        variantId: r.variantId,
        key: r.variantKey!,
        label: r.label!,
        description: r.description ?? null,
        isControl: r.isControl!,
        behaviour: r.behaviour!,
        assigned: r.assigned,
        succeeded: r.succeeded,
        failed: r.failed,
        pending: r.pending,
        successRate: decided > 0 ? r.succeeded / decided : null,
      });
    }
  }

  return c.json([...byExperiment.values()]);
});

export { backstageRouter };
