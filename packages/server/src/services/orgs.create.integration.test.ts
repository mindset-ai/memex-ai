import { describe, it, expect, afterAll } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { db } from "../db/connection.js";
import { memexes, namespaces, orgs, orgMemberships, users } from "../db/schema.js";
import { createOrgWithOwner } from "./orgs.js";
import { isSlugAvailable } from "./namespaces.js";
import { upsertUserByEmail } from "./users.js";
import { ConflictError, ValidationError } from "../types/errors.js";

const createdUserIds: string[] = [];
const createdNamespaceIds: string[] = [];

afterAll(async () => {
  if (createdUserIds.length) {
    await db.delete(users).where(inArray(users.id, createdUserIds)).catch(() => {});
  }
  if (createdNamespaceIds.length) {
    // Deleting the namespace cascades to org / memex / membership rows.
    await db.delete(namespaces).where(inArray(namespaces.id, createdNamespaceIds)).catch(() => {});
  }
});

function uniqueSubdomain(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`.toLowerCase();
}

function uniqueEmail(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`;
}

describe("isSlugAvailable", () => {
  it("returns true for an unused subdomain", async () => {
    expect(await isSlugAvailable(uniqueSubdomain("avail"))).toBe(true);
  });

  it("returns false for an existing subdomain", async () => {
    const sub = uniqueSubdomain("taken");
    const [ns] = await db.insert(namespaces).values({ slug: sub, kind: "org" }).returning();
    const [org] = await db.insert(orgs).values({ namespaceId: ns.id, name: "Taken" }).returning();
    await db.update(namespaces).set({ ownerOrgId: org.id }).where(eq(namespaces.id, ns.id));
    await db.insert(memexes).values({ namespaceId: ns.id, slug: "main", name: "Taken" });
    createdNamespaceIds.push(ns.id);

    expect(await isSlugAvailable(sub)).toBe(false);
  });

  it("is case-insensitive", async () => {
    const sub = uniqueSubdomain("case");
    const [ns] = await db.insert(namespaces).values({ slug: sub, kind: "org" }).returning();
    const [org] = await db.insert(orgs).values({ namespaceId: ns.id, name: "Case" }).returning();
    await db.update(namespaces).set({ ownerOrgId: org.id }).where(eq(namespaces.id, ns.id));
    await db.insert(memexes).values({ namespaceId: ns.id, slug: "main", name: "Case" });
    createdNamespaceIds.push(ns.id);

    expect(await isSlugAvailable(sub.toUpperCase())).toBe(false);
  });
});

describe("createOrgWithOwner", () => {
  it("creates org + administrator membership atomically (no Memex per dec-1 of doc-19)", async () => {
    const owner = await upsertUserByEmail(uniqueEmail("owner"));
    createdUserIds.push(owner.id);

    const sub = uniqueSubdomain("create");
    const { org, membership, namespace } = await createOrgWithOwner({
      slug: sub,
      ownerUserId: owner.id,
    });
    createdNamespaceIds.push(namespace.id);

    expect(namespace.slug).toBe(sub);
    expect(membership.userId).toBe(owner.id);
    expect(membership.orgId).toBe(org.id);
    expect(membership.role).toBe("administrator");

    // Verify the membership row exists.
    const fetched = await db.query.orgMemberships.findFirst({
      where: eq(orgMemberships.id, membership.id),
    });
    expect(fetched).toBeTruthy();

    // Per dec-1 of doc-19, the transaction creates ZERO memexes.
    const memexRows = await db.query.memexes.findMany({
      where: eq(memexes.namespaceId, namespace.id),
    });
    expect(memexRows).toHaveLength(0);
  });

  it("defaults name from subdomain when not provided", async () => {
    const owner = await upsertUserByEmail(uniqueEmail("name"));
    createdUserIds.push(owner.id);
    const sub = uniqueSubdomain("nm");

    const { org, namespace } = await createOrgWithOwner({
      slug: sub,
      ownerUserId: owner.id,
    });
    createdNamespaceIds.push(namespace.id);

    expect(org.name).toBe(sub.charAt(0).toUpperCase() + sub.slice(1));
  });

  it("uses provided name when present", async () => {
    const owner = await upsertUserByEmail(uniqueEmail("named"));
    createdUserIds.push(owner.id);

    const { org, namespace } = await createOrgWithOwner({
      slug: uniqueSubdomain("nx"),
      name: "Custom Workspace Name",
      ownerUserId: owner.id,
    });
    createdNamespaceIds.push(namespace.id);

    expect(org.name).toBe("Custom Workspace Name");
  });

  it("throws ValidationError for invalid subdomain format", async () => {
    const owner = await upsertUserByEmail(uniqueEmail("inv"));
    createdUserIds.push(owner.id);

    await expect(
      createOrgWithOwner({ slug: "ab", ownerUserId: owner.id })
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("throws ValidationError for reserved subdomains", async () => {
    const owner = await upsertUserByEmail(uniqueEmail("res"));
    createdUserIds.push(owner.id);

    await expect(
      createOrgWithOwner({ slug: "admin", ownerUserId: owner.id })
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("throws ConflictError on subdomain race (unique constraint)", async () => {
    const owner = await upsertUserByEmail(uniqueEmail("race"));
    createdUserIds.push(owner.id);
    const sub = uniqueSubdomain("rc");

    const { namespace } = await createOrgWithOwner({
      slug: sub,
      ownerUserId: owner.id,
    });
    createdNamespaceIds.push(namespace.id);

    const other = await upsertUserByEmail(uniqueEmail("race2"));
    createdUserIds.push(other.id);

    await expect(
      createOrgWithOwner({ slug: sub, ownerUserId: other.id })
    ).rejects.toBeInstanceOf(ConflictError);
  });
});
