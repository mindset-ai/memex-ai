import { describe, it, expect, afterAll } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { db } from "../db/connection.js";
import { memexes, namespaces, orgs, orgMemberships, users } from "../db/schema.js";
import { upsertUserByEmail } from "./users.js";
import {
  countActiveAdmins,
  disableMembership,
  enableMembership,
  updateMembershipRole,
  MembershipActionError,
} from "./org-memberships.js";

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

function uniqueEmail(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`;
}

// Returns the org.id (the legacy "memexId" in account-membership service
// signatures maps to org.id post-doc-15).
async function makeAccount(): Promise<string> {
  const sub = uniqueSubdomain("at");
  const [ns] = await db.insert(namespaces).values({ slug: sub, kind: "org" }).returning();
  const [org] = await db.insert(orgs).values({ namespaceId: ns.id, name: "Admin Test" }).returning();
  await db.update(namespaces).set({ ownerOrgId: org.id }).where(eq(namespaces.id, ns.id));
  const [acct] = await db.insert(memexes).values({ namespaceId: ns.id, slug: "main", name: "Admin Test" }).returning();
  createdAccountIds.push(acct.id);
  return org.id;
}

async function makeMember(
  email: string,
  memexId: string,
  role: "member" | "administrator",
  status: "active" | "disabled" = "active"
): Promise<string> {
  const user = await upsertUserByEmail(email);
  if (!createdUserIds.includes(user.id)) createdUserIds.push(user.id);
  await db
    .delete(orgMemberships)
    .where(eq(orgMemberships.userId, user.id));
  await db.insert(orgMemberships).values({
    userId: user.id,
    orgId: memexId,
    role,
    status,
  });
  return user.id;
}

describe("countActiveAdmins", () => {
  it("counts only active administrators", async () => {
    const memexId = await makeAccount();
    await makeMember(uniqueEmail("a1"), memexId, "administrator");
    await makeMember(uniqueEmail("a2"), memexId, "administrator");
    await makeMember(uniqueEmail("u1"), memexId, "member");
    const adminA3 = await makeMember(uniqueEmail("a3"), memexId, "administrator", "disabled");
    expect(adminA3).toBeTruthy();

    expect(await countActiveAdmins(memexId)).toBe(2);
  });
});

describe("disableMembership", () => {
  it("disables a regular user", async () => {
    const memexId = await makeAccount();
    const adminId = await makeMember(uniqueEmail("admin"), memexId, "administrator");
    const userId = await makeMember(uniqueEmail("member"), memexId, "member");

    const result = await disableMembership(userId, memexId, adminId);
    expect(result.status).toBe("disabled");
  });

  it("disables a non-last admin", async () => {
    const memexId = await makeAccount();
    const adminA = await makeMember(uniqueEmail("aa"), memexId, "administrator");
    const adminB = await makeMember(uniqueEmail("ab"), memexId, "administrator");

    const result = await disableMembership(adminB, memexId, adminA);
    expect(result.status).toBe("disabled");
  });

  it("rejects removing the last administrator", async () => {
    const memexId = await makeAccount();
    const onlyAdmin = await makeMember(uniqueEmail("only"), memexId, "administrator");
    const otherAdmin = await makeMember(uniqueEmail("other"), memexId, "administrator");

    // Try to disable the last remaining admin (other)
    await disableMembership(otherAdmin, memexId, onlyAdmin); // OK, leaves 1
    await expect(
      disableMembership(onlyAdmin, memexId, otherAdmin) // OK as caller, but last admin
    ).rejects.toMatchObject({ name: "MembershipActionError", code: "last_admin" });
  });

  it("rejects self-removal", async () => {
    const memexId = await makeAccount();
    const adminA = await makeMember(uniqueEmail("self"), memexId, "administrator");
    const adminB = await makeMember(uniqueEmail("other"), memexId, "administrator");
    expect(adminB).toBeTruthy();

    await expect(disableMembership(adminA, memexId, adminA))
      .rejects.toMatchObject({ name: "MembershipActionError", code: "cannot_remove_self" });
  });

  it("is idempotent for already-disabled members", async () => {
    const memexId = await makeAccount();
    const adminId = await makeMember(uniqueEmail("admin"), memexId, "administrator");
    const userId = await makeMember(uniqueEmail("member"), memexId, "member", "disabled");

    const result = await disableMembership(userId, memexId, adminId);
    expect(result.status).toBe("disabled");
  });
});

describe("enableMembership", () => {
  it("re-activates a disabled member", async () => {
    const memexId = await makeAccount();
    const userId = await makeMember(uniqueEmail("dis"), memexId, "member", "disabled");

    const result = await enableMembership(userId, memexId);
    expect(result.status).toBe("active");
  });

  it("is a no-op for active members", async () => {
    const memexId = await makeAccount();
    const userId = await makeMember(uniqueEmail("act"), memexId, "member");

    const result = await enableMembership(userId, memexId);
    expect(result.status).toBe("active");
  });
});

describe("updateMembershipRole", () => {
  it("promotes a user to admin", async () => {
    const memexId = await makeAccount();
    const adminId = await makeMember(uniqueEmail("a"), memexId, "administrator");
    const userId = await makeMember(uniqueEmail("u"), memexId, "member");

    const result = await updateMembershipRole(userId, memexId, "administrator", adminId);
    expect(result.role).toBe("administrator");
  });

  it("demotes an admin when another admin remains", async () => {
    const memexId = await makeAccount();
    const adminA = await makeMember(uniqueEmail("a"), memexId, "administrator");
    const adminB = await makeMember(uniqueEmail("b"), memexId, "administrator");

    const result = await updateMembershipRole(adminB, memexId, "member", adminA);
    expect(result.role).toBe("member");
  });

  it("rejects demoting the last administrator", async () => {
    const memexId = await makeAccount();
    const onlyAdmin = await makeMember(uniqueEmail("only"), memexId, "administrator");

    await expect(
      updateMembershipRole(onlyAdmin, memexId, "member", onlyAdmin)
    ).rejects.toMatchObject({ name: "MembershipActionError", code: "last_admin" });
  });

  it("rejects role change on disabled members", async () => {
    const memexId = await makeAccount();
    const adminId = await makeMember(uniqueEmail("a"), memexId, "administrator");
    const userId = await makeMember(uniqueEmail("d"), memexId, "member", "disabled");

    await expect(
      updateMembershipRole(userId, memexId, "administrator", adminId)
    ).rejects.toMatchObject({ name: "MembershipActionError", code: "not_found" });
  });
});
