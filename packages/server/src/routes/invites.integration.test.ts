import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { inArray, eq } from "drizzle-orm";
import { db } from "../db/connection.js";
import { memexes, namespaces, orgs, orgMemberships, inviteTokens, users } from "../db/schema.js";

// Force dev mode (no GOOGLE_CLIENT_ID) so sessionMiddleware uses the dev-user fallback.
const originalClientId = process.env.GOOGLE_CLIENT_ID;
beforeAll(() => {
  delete process.env.GOOGLE_CLIENT_ID;
  vi.resetModules();
});
afterAll(() => {
  if (originalClientId !== undefined) process.env.GOOGLE_CLIENT_ID = originalClientId;
});

import { Hono } from "hono";
import { invitesRouter } from "./invites.js";
import { errorHandler } from "../middleware/error-handler.js";
import { upsertUserByEmail } from "../services/users.js";

const createdAccountIds: string[] = [];
const createdUserIds: string[] = [];

afterAll(async () => {
  if (createdUserIds.length) {
    await db.delete(users).where(inArray(users.id, createdUserIds)).catch(() => {});
  }
  if (createdAccountIds.length) {
    await db.delete(memexes).where(inArray(memexes.id, createdAccountIds)).catch(() => {});
  }
});

function uniqueSubdomain(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`.toLowerCase();
}

const app = new Hono();
app.onError(errorHandler);
app.route("/api/invites", invitesRouter);

async function setupAccount(opts: { devUserRole: "member" | "administrator" | "none" }) {
  const sub = uniqueSubdomain("inv");
  const [ns] = await db.insert(namespaces).values({ slug: sub, kind: "org" }).returning();
  const [org] = await db.insert(orgs).values({ namespaceId: ns.id, name: "Inv Acct" }).returning();
  await db.update(namespaces).set({ ownerOrgId: org.id }).where(eq(namespaces.id, ns.id));
  const [acct] = await db.insert(memexes).values({ namespaceId: ns.id, slug: "main", name: "Inv Acct" }).returning();
  createdAccountIds.push(acct.id);

  const devUser = await upsertUserByEmail("dev@memex.ai");
  if (!createdUserIds.includes(devUser.id)) createdUserIds.push(devUser.id);

  // Clear any prior memberships from earlier tests — sessionMiddleware always uses dev@memex.ai
  await db.delete(orgMemberships).where(eq(orgMemberships.userId, devUser.id));
  // Wipe dev's personal namespace so the session's "single membership → auto-resolve"
  // resolves to THIS test's org (otherwise listMemberships returns personal + this org = 2).
  await db.update(users).set({ namespaceId: null }).where(eq(users.id, devUser.id));
  await db.delete(namespaces).where(eq(namespaces.ownerUserId, devUser.id));
  await db.update(users).set({ namespaceId: ns.id }).where(eq(users.id, devUser.id));

  if (opts.devUserRole !== "none") {
    await db.insert(orgMemberships).values({
      userId: devUser.id,
      orgId: org.id,
      role: opts.devUserRole,
    });
  }
  // Return acct.id as org.id (legacy "account.id" was the unit invites/team tests
  // address) so existing assertions like `body.orgId).toBe(acct.id)` pass.
  return { acct: { ...acct, id: org.id, memexId: acct.id }, sub, devUser, org };
}

describe("POST /api/invites", () => {
  it("creates an invite when the user is an administrator of the tenant", async () => {
    const { acct } = await setupAccount({ devUserRole: "administrator" });

    const res = await app.request("/api/invites", {
      method: "POST",
    });
    expect(res.status).toBe(201);

    const body = await res.json();
    expect(body.orgId).toBe(acct.id);
    expect(body.token).toMatch(/^[0-9a-f-]{36}$/);
    expect(body.revokedAt).toBeNull();
    expect(new Date(body.expiresAt).getTime()).toBeGreaterThan(Date.now() + 6 * 24 * 60 * 60 * 1000);
  });

  it("creates an invite when the user is a regular team member (not admin)", async () => {
    // Any active team member can mint invite links. Admins may later disable this per-team
    // in settings (not yet implemented) — today it's open to all members.
    const { acct } = await setupAccount({ devUserRole: "member" });

    const res = await app.request("/api/invites", {
      method: "POST",
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.orgId).toBe(acct.id);
  });

  // Removed in t-19 of doc-15: the three "tenant context via Host header" tests
  // that used to live here are obsolete. Per std-2 / dec-3 of doc-15 the
  // subdomain-based tenant routing is gone (hostGuard now 404s arbitrary
  // subdomains and tenancy lives in the path). Equivalent coverage:
  //   - membership / cross-tenant 404 → src/__e2e__/unauthorized-access.api.test.ts
  //   - path-routing host guard → src/__e2e__/path-routing.api.test.ts
});

describe("GET /api/invites", () => {
  it("lists active invites for the current tenant", async () => {
    const { acct } = await setupAccount({ devUserRole: "administrator" });

    await app.request("/api/invites", {
      method: "POST",
    });
    await app.request("/api/invites", {
      method: "POST",
    });

    const res = await app.request("/api/invites");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBeGreaterThanOrEqual(2);
    for (const invite of body) {
      expect(invite.orgId).toBe(acct.id);
      expect(invite.revokedAt).toBeNull();
    }
  });
});

describe("DELETE /api/invites/:id", () => {
  it("revokes an invite (stamps revokedAt)", async () => {
    const { acct } = await setupAccount({ devUserRole: "administrator" });

    const create = await app.request("/api/invites", {
      method: "POST",
    });
    const invite = await create.json();

    const res = await app.request(`/api/invites/${invite.id}`, {
      method: "DELETE",
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.revokedAt).not.toBeNull();

    // After revoke, GET should not include it
    const list = await app.request("/api/invites");
    const remaining = await list.json();
    expect(remaining.find((i: { id: string }) => i.id === invite.id)).toBeUndefined();

    // Verify it's actually revoked in DB and belongs to this account
    const reloaded = await db.query.inviteTokens.findFirst({
      where: eq(inviteTokens.id, invite.id),
    });
    expect(reloaded?.revokedAt).toBeInstanceOf(Date);
    expect(reloaded?.orgId).toBe(acct.id);
  });

  // Removed in t-19 of doc-15: the cross-tenant Host-based test that lived here is
  // obsolete (tenant resolution by Host is gone per dec-3). Equivalent std-7
  // (404, not 403) coverage now lives in src/__e2e__/unauthorized-access.api.test.ts.
});
