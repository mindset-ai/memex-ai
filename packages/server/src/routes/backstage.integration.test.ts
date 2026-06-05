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

const createdAccountIds: string[] = [];
const createdUserIds: string[] = [];

afterAll(async () => {
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
