import { describe, it, expect, afterAll, beforeAll, vi } from "vitest";
import { inArray, eq, and } from "drizzle-orm";
import { db } from "../db/connection.js";
import {
  memexes,
  namespaces,
  orgs,
  orgMemberships,
  documents,
  users,
  experiments,
  experimentVariants,
  experimentAssignments,
} from "../db/schema.js";

// Force dev mode so the backstage gate opens. Restore whatever was set before.
const originalClientId = process.env.GOOGLE_CLIENT_ID;
beforeAll(() => {
  delete process.env.GOOGLE_CLIENT_ID;
  vi.resetModules();
});
afterAll(() => {
  if (originalClientId !== undefined) {
    process.env.GOOGLE_CLIENT_ID = originalClientId;
  }
});

import { Hono } from "hono";
import { backstageRouter } from "./backstage.js";
import { errorHandler } from "../middleware/error-handler.js";
import { upsertUserByEmail } from "../services/users.js";
import { isDevMode } from "../middleware/session.js";
import { tagAc } from "@memex-ai-ac/vitest";

const createdAccountIds: string[] = [];
const createdUserIds: string[] = [];
const createdExperimentIds: string[] = [];

afterAll(async () => {
  if (createdExperimentIds.length) {
    // Variants + assignments cascade from the experiment (onDelete: cascade).
    await db
      .delete(experiments)
      .where(inArray(experiments.id, createdExperimentIds))
      .catch(() => {});
  }
  if (createdUserIds.length) {
    await db
      .delete(users)
      .where(inArray(users.id, createdUserIds))
      .catch(() => {});
  }
  if (createdAccountIds.length) {
    await db
      .delete(memexes)
      .where(inArray(memexes.id, createdAccountIds))
      .catch(() => {});
  }
});

function uniqueSubdomain(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 8)}`.toLowerCase();
}

// Build the namespace+org+memex tuple post-doc-15. Returns memex (legacy
// "account" handle) and the org id, since orgMemberships lives on org_id.
async function seedMemexTuple(name: string, slug: string): Promise<{
  memex: { id: string };
  org: { id: string };
  namespace: { id: string; slug: string };
}> {
  const [ns] = await db.insert(namespaces).values({ slug, kind: "org" }).returning();
  const [org] = await db.insert(orgs).values({ namespaceId: ns.id, name }).returning();
  await db.update(namespaces).set({ ownerOrgId: org.id }).where(eq(namespaces.id, ns.id));
  const [memex] = await db.insert(memexes).values({ namespaceId: ns.id, slug: "main", name }).returning();
  return { memex, org, namespace: ns };
}

const app = new Hono();
app.onError(errorHandler);
app.route("/api/backstage", backstageRouter);

// Re-enabled in t-19 of doc-15: backstage routes stay at /api/backstage/accounts
// per the internal-name convention (route paths / TS types remain `account` even
// though the user-facing noun is "Memex"). Tests updated to use the real path.
describe("GET /api/backstage/accounts", () => {
  it("returns memexes with member + doc counts", async () => {
    const sub = uniqueSubdomain("bs-list");
    const { memex: acct, org } = await seedMemexTuple("Backstage List", sub);
    createdAccountIds.push(acct.id);

    // Seed two active members + one doc to exercise the aggregation counters.
    const dev = await upsertUserByEmail("dev@memex.ai");
    const other = await upsertUserByEmail(
      `bs-other-${Date.now().toString(36)}@example.com`
    );
    if (!createdUserIds.includes(dev.id)) createdUserIds.push(dev.id);
    createdUserIds.push(other.id);

    await db
      .insert(orgMemberships)
      .values([
        { userId: dev.id, orgId: org.id, role: "administrator" },
        { userId: other.id, orgId: org.id, role: "member" },
      ])
      .onConflictDoNothing();

    await db.insert(documents).values({
      memexId: acct.id,
      handle: "doc-1",
      title: "Bs Doc",
      docType: "spec",
    });

    const res = await app.request("/api/backstage/accounts");
    expect(res.status).toBe(200);

    const rows = (await res.json()) as Array<{
      id: string;
      memberCount: number;
      docCount: number;
    }>;
    const row = rows.find((r) => r.id === acct.id);
    expect(row).toBeDefined();
    expect(row!.memberCount).toBe(2);
    expect(row!.docCount).toBe(1);
  });

  it("returns 403 when dev mode is off", async () => {
    process.env.GOOGLE_CLIENT_ID = "test-client-id";
    try {
      const res = await app.request("/api/backstage/accounts");
      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body.error).toBe("Backstage disabled");
    } finally {
      delete process.env.GOOGLE_CLIENT_ID;
    }
  });
});

describe("POST /api/backstage/accounts/:id/impersonate", () => {
  it("grants dev@memex.ai an administrator membership on the target account", async () => {
    const sub = uniqueSubdomain("bs-imp");
    const { memex: acct, org } = await seedMemexTuple("Impersonate Me", sub);
    createdAccountIds.push(acct.id);

    const res = await app.request(
      `/api/backstage/accounts/${acct.id}/impersonate`,
      { method: "POST" }
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ memexId: acct.id, slug: sub });

    const dev = await upsertUserByEmail("dev@memex.ai");
    if (!createdUserIds.includes(dev.id)) createdUserIds.push(dev.id);

    const [membership] = await db
      .select()
      .from(orgMemberships)
      .where(
        and(
          eq(orgMemberships.userId, dev.id),
          eq(orgMemberships.orgId, org.id)
        )
      );
    expect(membership).toBeDefined();
    expect(membership.role).toBe("administrator");
    expect(membership.status).toBe("active");
  });

  it("re-promotes dev to administrator even if a prior row demoted them to user", async () => {
    const sub = uniqueSubdomain("bs-repromo");
    const { memex: acct, org } = await seedMemexTuple("Re-promote", sub);
    createdAccountIds.push(acct.id);

    const dev = await upsertUserByEmail("dev@memex.ai");
    if (!createdUserIds.includes(dev.id)) createdUserIds.push(dev.id);

    // Simulate a previous demotion — the impersonate call must lift them back to admin.
    await db
      .insert(orgMemberships)
      .values({
        userId: dev.id,
        orgId: org.id,
        role: "member",
        status: "disabled",
      })
      .onConflictDoUpdate({
        target: [orgMemberships.userId, orgMemberships.orgId],
        set: { role: "member", status: "disabled" },
      });

    const res = await app.request(
      `/api/backstage/accounts/${acct.id}/impersonate`,
      { method: "POST" }
    );
    expect(res.status).toBe(200);

    const [membership] = await db
      .select()
      .from(orgMemberships)
      .where(
        and(
          eq(orgMemberships.userId, dev.id),
          eq(orgMemberships.orgId, org.id)
        )
      );
    expect(membership.role).toBe("administrator");
    expect(membership.status).toBe("active");
  });

  it("returns 404 for a non-existent account", async () => {
    const res = await app.request(
      "/api/backstage/accounts/00000000-0000-0000-0000-000000000000/impersonate",
      { method: "POST" }
    );
    expect(res.status).toBe(404);
  });

  it("returns 403 when dev mode is off", async () => {
    const sub = uniqueSubdomain("bs-gated");
    const { memex: acct } = await seedMemexTuple("Gated", sub);
    createdAccountIds.push(acct.id);

    process.env.GOOGLE_CLIENT_ID = "test-client-id";
    try {
      const res = await app.request(
        `/api/backstage/accounts/${acct.id}/impersonate`,
        { method: "POST" }
      );
      expect(res.status).toBe(403);
    } finally {
      delete process.env.GOOGLE_CLIENT_ID;
    }
  });
});

describe("GET /api/backstage/experiments (spec-426 ac-4)", () => {
  it("returns per-experiment, per-arm tallies with success rate over decided assignments", async () => {
    tagAc("mindset-prod/memex-building-itself/specs/spec-426/acs/ac-4");

    const suffix = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const [exp] = await db
      .insert(experiments)
      .values({
        key: `bs-exp-${suffix}`,
        statement: "B (starter spec) beats A (handhold demo) on activation.",
        status: "running",
        windowDays: 7,
      })
      .returning();
    createdExperimentIds.push(exp.id);

    const [armA, armB] = await db
      .insert(experimentVariants)
      .values([
        { experimentId: exp.id, key: "A", label: "Control", isControl: true, behaviour: "handhold_demo" },
        { experimentId: exp.id, key: "B", label: "Treatment", isControl: false, behaviour: "starter_spec" },
      ])
      .returning();

    // Three users for the A arm, two for B — exercise distinct outcomes per arm.
    const mkUser = async (n: string) =>
      upsertUserByEmail(`bs-exp-${n}-${suffix}@example.com`);
    const [u1, u2, u3, u4, u5] = await Promise.all([
      mkUser("1"),
      mkUser("2"),
      mkUser("3"),
      mkUser("4"),
      mkUser("5"),
    ]);
    for (const u of [u1, u2, u3, u4, u5]) createdUserIds.push(u.id);

    await db.insert(experimentAssignments).values([
      // Arm A: 1 succeeded, 1 failed, 1 pending → assigned 3, rate 50% (1 of 2 decided).
      { experimentId: exp.id, variantId: armA.id, userId: u1.id, assignedBy: "auto", outcome: "succeeded" },
      { experimentId: exp.id, variantId: armA.id, userId: u2.id, assignedBy: "auto", outcome: "failed" },
      { experimentId: exp.id, variantId: armA.id, userId: u3.id, assignedBy: "auto", outcome: "pending" },
      // Arm B: 2 succeeded → assigned 2, rate 100%.
      { experimentId: exp.id, variantId: armB.id, userId: u4.id, assignedBy: "auto", outcome: "succeeded" },
      { experimentId: exp.id, variantId: armB.id, userId: u5.id, assignedBy: "auto", outcome: "succeeded" },
    ]);

    // A superseded (historical) assignment must NOT be tallied — only the active row counts.
    await db.insert(experimentAssignments).values({
      experimentId: exp.id,
      variantId: armB.id,
      userId: u1.id,
      assignedBy: "operator",
      outcome: "failed",
      supersededAt: new Date(),
    });

    const res = await app.request("/api/backstage/experiments");
    expect(res.status).toBe(200);

    const body = (await res.json()) as Array<{
      experimentId: string;
      key: string;
      status: string;
      windowDays: number;
      variants: Array<{
        key: string;
        isControl: boolean;
        behaviour: string;
        assigned: number;
        succeeded: number;
        failed: number;
        pending: number;
        successRate: number | null;
      }>;
    }>;

    const row = body.find((e) => e.experimentId === exp.id);
    expect(row).toBeDefined();
    expect(row!.status).toBe("running");
    expect(row!.windowDays).toBe(7);

    const a = row!.variants.find((v) => v.key === "A")!;
    const b = row!.variants.find((v) => v.key === "B")!;
    expect(a.isControl).toBe(true);
    expect(a.behaviour).toBe("handhold_demo");
    expect(a.assigned).toBe(3);
    expect(a.succeeded).toBe(1);
    expect(a.failed).toBe(1);
    expect(a.pending).toBe(1);
    expect(a.successRate).toBeCloseTo(0.5);

    expect(b.behaviour).toBe("starter_spec");
    expect(b.assigned).toBe(2); // superseded row excluded
    expect(b.succeeded).toBe(2);
    expect(b.failed).toBe(0);
    expect(b.pending).toBe(0);
    expect(b.successRate).toBeCloseTo(1);
  });

  it("returns 403 when dev mode is off", async () => {
    process.env.GOOGLE_CLIENT_ID = "test-client-id";
    try {
      const res = await app.request("/api/backstage/experiments");
      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body.error).toBe("Backstage disabled");
    } finally {
      delete process.env.GOOGLE_CLIENT_ID;
    }
  });
});

describe("spec-199 Finding #2 — backstage fails closed in production when GOOGLE_CLIENT_ID is missing (ac-2)", () => {
  it("isDevMode() throws when GOOGLE_CLIENT_ID is unset in NODE_ENV=production", () => {
    tagAc("mindset-prod/memex-building-itself/specs/spec-199/acs/ac-2");
    const originalNodeEnv = process.env.NODE_ENV;
    const savedClientId = process.env.GOOGLE_CLIENT_ID;
    try {
      process.env.NODE_ENV = "production";
      delete process.env.GOOGLE_CLIENT_ID;
        // isDevMode reads process.env at call time — static import is fine here.
      expect(() => isDevMode()).toThrow(/GOOGLE_CLIENT_ID is required in production/);
    } finally {
      process.env.NODE_ENV = originalNodeEnv;
      if (savedClientId !== undefined) process.env.GOOGLE_CLIENT_ID = savedClientId;
      else delete process.env.GOOGLE_CLIENT_ID;
    }
  });
});
