// Member-level access matrix for the Emission Keys API (spec-129 dec-8, t-11).
//
// Exercises the real app + DB through /api/:namespace/:memex/emission-keys with TWO
// identities on the same Memex: the org owner (administrator) and a second user added as a
// plain `member`. Asserts the dec-8 matrix:
//   - member        → create; list-own; revoke-own; CANNOT see/revoke others' keys.
//   - administrator → create; list-all; revoke-any.
// "Own" is derived from memex_emission_keys.created_by_user_id (set at mint).

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { tagAc } from "@memex-ai-ac/vitest";
import { db } from "../db/connection.js";
import { app } from "../app.js";
import { users, memexEmissionKeys, orgMemberships } from "../db/schema.js";
import { signSessionToken } from "../services/auth-jwt.js";
import { createOrgWithMemexAndOwner } from "../services/__test__/seed-org.js";

const AC_18 = "mindset-prod/memex-building-itself/specs/spec-129/acs/ac-18"; // member can create
const AC_19 = "mindset-prod/memex-building-itself/specs/spec-129/acs/ac-19"; // list scoped by role
const AC_20 = "mindset-prod/memex-building-itself/specs/spec-129/acs/ac-20"; // revoke by ownership
const AC_21 = "mindset-prod/memex-building-itself/specs/spec-129/acs/ac-21"; // created_by_user_id set at mint

const createdUserIds: string[] = [];
const createdMemexIds: string[] = [];

afterAll(async () => {
  if (createdMemexIds.length) {
    await db
      .delete(memexEmissionKeys)
      .where(inArray(memexEmissionKeys.memexId, createdMemexIds))
      .catch(() => {});
  }
  for (const id of createdUserIds) {
    await db.delete(users).where(eq(users.id, id)).catch(() => {});
  }
});

async function seedUser(): Promise<string> {
  const [u] = await db
    .insert(users)
    .values({
      email: `emit-member-${crypto.randomUUID()}@example.com`,
      emailVerifiedAt: new Date(),
    } as typeof users.$inferInsert)
    .returning();
  createdUserIds.push(u.id);
  return u.id;
}

async function authed(
  path: string,
  bearer: string,
  init: RequestInit = {},
): Promise<Response> {
  const headers = new Headers(init.headers ?? {});
  headers.set("Authorization", `Bearer ${bearer}`);
  headers.set("Host", "memex.ai");
  if (init.body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  return app.request(path, { ...init, headers });
}

describe("emission-keys member-level access (spec-129 dec-8)", () => {
  beforeEach(() => {
    if (!process.env.GOOGLE_CLIENT_ID) {
      process.env.GOOGLE_CLIENT_ID = "test-client.apps.googleusercontent.com";
    }
  });

  let adminUserId: string;
  let memberUserId: string;
  let adminBearer: string;
  let memberBearer: string;
  let memexId: string;
  let base: string;

  const mint = async (bearer: string, name: string) => {
    const res = await authed(base, bearer, {
      method: "POST",
      body: JSON.stringify({ name }),
    });
    return { res, body: (await res.json()) as Record<string, unknown> };
  };

  const list = async (bearer: string) => {
    const res = await authed(base, bearer, { method: "GET" });
    return (await res.json()) as Array<{ id: string; createdByUserId: string | null }>;
  };

  beforeAll(async () => {
    adminUserId = await seedUser();
    adminBearer = signSessionToken(adminUserId);
    const seeded = await createOrgWithMemexAndOwner({
      slug: `emit-mbr-${Date.now().toString(36)}`,
      ownerUserId: adminUserId,
    });
    memexId = seeded.memex.id;
    createdMemexIds.push(memexId);
    base = `/api/${seeded.namespace.slug}/${seeded.memex.slug}/emission-keys`;

    // Second user joins the SAME org as a plain member (role:'member' → memex member).
    memberUserId = await seedUser();
    await db.insert(orgMemberships).values({
      userId: memberUserId,
      orgId: seeded.org.id,
      role: "member",
      status: "active",
    });
    memberBearer = signSessionToken(memberUserId);
  });

  it("a non-admin member can create a key, and it records them as creator (ac-18, ac-21)", async () => {
    tagAc(AC_18);
    tagAc(AC_21);
    const { res, body } = await mint(memberBearer, "member key");
    expect(res.status).toBe(201);
    expect(body.createdByUserId).toBe(memberUserId);

    // Persisted column matches (ac-21: created_by_user_id set at mint time).
    const row = await db.query.memexEmissionKeys.findFirst({
      where: eq(memexEmissionKeys.id, body.id as string),
    });
    expect(row?.createdByUserId).toBe(memberUserId);
  });

  it("a member sees only their OWN keys; an admin sees ALL keys (ac-19)", async () => {
    tagAc(AC_19);
    const adminKey = await mint(adminBearer, "admin-only key");
    const memberKey = await mint(memberBearer, "member-owned key");

    const memberList = await list(memberBearer);
    const memberIds = memberList.map((r) => r.id);
    expect(memberIds).toContain(memberKey.body.id);
    expect(memberIds).not.toContain(adminKey.body.id);
    // Every row the member sees is genuinely theirs.
    expect(memberList.every((r) => r.createdByUserId === memberUserId)).toBe(true);

    const adminList = await list(adminBearer);
    const adminIds = adminList.map((r) => r.id);
    expect(adminIds).toContain(adminKey.body.id);
    expect(adminIds).toContain(memberKey.body.id);
  });

  it("a member can revoke their own key (ac-20)", async () => {
    tagAc(AC_20);
    const own = await mint(memberBearer, "to-revoke-self");
    const res = await authed(`${base}/${own.body.id}/revoke`, memberBearer, {
      method: "POST",
    });
    expect(res.status).toBe(200);
    const row = await db.query.memexEmissionKeys.findFirst({
      where: eq(memexEmissionKeys.id, own.body.id as string),
    });
    expect(row?.revokedAt).not.toBeNull();
  });

  it("a member CANNOT revoke a key created by someone else — 404, no state change (ac-20)", async () => {
    tagAc(AC_20);
    const adminKey = await mint(adminBearer, "admin key untouchable");
    const res = await authed(`${base}/${adminKey.body.id}/revoke`, memberBearer, {
      method: "POST",
    });
    expect(res.status).toBe(404);
    // The admin's key is untouched — still live.
    const row = await db.query.memexEmissionKeys.findFirst({
      where: eq(memexEmissionKeys.id, adminKey.body.id as string),
    });
    expect(row?.revokedAt).toBeNull();
  });

  it("an admin can revoke a member's key (ac-20)", async () => {
    tagAc(AC_20);
    const memberKey = await mint(memberBearer, "member key admin-revokes");
    const res = await authed(`${base}/${memberKey.body.id}/revoke`, adminBearer, {
      method: "POST",
    });
    expect(res.status).toBe(200);
    const row = await db.query.memexEmissionKeys.findFirst({
      where: eq(memexEmissionKeys.id, memberKey.body.id as string),
    });
    expect(row?.revokedAt).not.toBeNull();
  });
});
