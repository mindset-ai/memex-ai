import { describe, it, expect, afterAll, beforeAll, vi } from "vitest";
import { inArray, eq } from "drizzle-orm";
import { db } from "../db/connection.js";
import { memexes, namespaces, orgs, orgMemberships, users } from "../db/schema.js";

// Force dev mode so sessionMiddleware uses dev@memex.ai without needing a real JWT.
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
import { teamRouter } from "./team.js";
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

const app = new Hono();
app.onError(errorHandler);
app.route("/api/team", teamRouter);

async function setupTeam(opts: {
  kind?: "team" | "personal";
  devRole?: "member" | "administrator" | "none";
}) {
  const sub = uniqueSubdomain("tm");
  const kind = opts.kind ?? "team";
  // Build a namespace + (org if team) + memex tuple. For the legacy
  // kind="personal" branch we still use a user-namespace shape, but with a
  // dummy owner so the FK passes.
  const dev = await upsertUserByEmail("dev@memex.ai");
  if (!createdUserIds.includes(dev.id)) createdUserIds.push(dev.id);

  const [ns] = await db.insert(namespaces).values({
    slug: sub,
    kind: kind === "team" ? "org" : "user",
    ownerUserId: kind === "personal" ? dev.id : null,
  }).returning();

  let org: { id: string } | null = null;
  if (kind === "team") {
    [org] = await db.insert(orgs).values({ namespaceId: ns.id, name: "Team Test" }).returning();
    await db.update(namespaces).set({ ownerOrgId: org.id }).where(eq(namespaces.id, ns.id));
  }
  const [acct] = await db.insert(memexes).values({ namespaceId: ns.id, slug: "main", name: "Team Test" }).returning();
  createdAccountIds.push(acct.id);

  // Clear prior memberships AND the personal namespace so the session
  // middleware's "exactly one membership → auto-resolve" path picks THIS
  // test's org.
  await db.delete(orgMemberships).where(eq(orgMemberships.userId, dev.id));
  await db.update(users).set({ namespaceId: null }).where(eq(users.id, dev.id));
  await db.delete(namespaces).where(eq(namespaces.ownerUserId, dev.id));
  await db.update(users).set({ namespaceId: ns.id }).where(eq(users.id, dev.id));

  if (opts.devRole && opts.devRole !== "none" && org) {
    await db
      .insert(orgMemberships)
      .values({ userId: dev.id, orgId: org.id, role: opts.devRole });
  }
  // Return acct as { id: org.id } when team so existing assertions that
  // pass acct.id to orgMemberships inserts continue to work.
  const acctShim = org
    ? { ...acct, id: org.id, memexId: acct.id }
    : acct;
  return { acct: acctShim, sub };
}

describe("GET /api/team/members", () => {
  it("returns active members with the safe subset of fields", async () => {
    const { acct } = await setupTeam({ devRole: "administrator" });

    // Add a second active member + a third disabled one to prove filtering.
    const activeOther = await upsertUserByEmail(
      `tm-active-${Date.now().toString(36)}@example.com`
    );
    const disabledOther = await upsertUserByEmail(
      `tm-disabled-${Date.now().toString(36)}@example.com`
    );
    createdUserIds.push(activeOther.id, disabledOther.id);

    await db.insert(orgMemberships).values([
      { userId: activeOther.id, orgId: acct.id, role: "member" },
      {
        userId: disabledOther.id,
        orgId: acct.id,
        role: "member",
        status: "disabled",
      },
    ] as any);

    const res = await app.request("/api/team/members");
    expect(res.status).toBe(200);

    const body = (await res.json()) as Array<{
      userId: string;
      email: string;
      role: string;
      joinedAt: string;
      status?: string;
    }>;

    expect(body.some((m) => m.userId === activeOther.id)).toBe(true);
    expect(body.some((m) => m.userId === disabledOther.id)).toBe(false);
    // status must not leak to the team-visible response.
    expect(body.every((m) => !("status" in m))).toBe(true);
  });

  // Removed in t-19 of doc-15: three "tenant context via Host header" tests
  // that used to live here are obsolete. Per std-2 / dec-3 the subdomain-based
  // tenant routing is gone — hostGuard 404s arbitrary subdomains. Personal-
  // memex rejection, bare-host behavior, and non-member 403/404 are covered by:
  //   - src/__e2e__/unauthorized-access.api.test.ts
  //   - src/__e2e__/path-routing.api.test.ts
});
