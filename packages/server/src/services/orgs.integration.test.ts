import { describe, it, expect, afterAll } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { db } from "../db/connection.js";
import { memexes, namespaces, orgs } from "../db/schema.js";
import { getNamespaceBySlug } from "./namespaces.js";
import { getMemexById } from "./memexes.js";

const createdAccountIds: string[] = [];

afterAll(async () => {
  if (createdAccountIds.length) {
    await db.delete(memexes).where(inArray(memexes.id, createdAccountIds)).catch(() => {});
  }
});

function uniqueSubdomain(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`.toLowerCase();
}

async function seedTuple(name: string, slug: string) {
  const [ns] = await db.insert(namespaces).values({ slug, kind: "org" }).returning();
  const [org] = await db.insert(orgs).values({ namespaceId: ns.id, name }).returning();
  await db.update(namespaces).set({ ownerOrgId: org.id }).where(eq(namespaces.id, ns.id));
  const [memex] = await db.insert(memexes).values({ namespaceId: ns.id, slug: "main", name }).returning();
  return { memex, org, namespace: ns };
}

describe("getNamespaceBySlug", () => {
  it("finds an existing namespace by slug", async () => {
    const sub = uniqueSubdomain("ga");
    const { memex, namespace } = await seedTuple("GA Test", sub);
    createdAccountIds.push(memex.id);

    const found = await getNamespaceBySlug(sub);
    expect(found?.slug).toBe(sub);
    expect(found?.id).toBe(namespace.id);
  });

  it("normalizes subdomain casing", async () => {
    const sub = uniqueSubdomain("case");
    const { memex, namespace } = await seedTuple("Case Test", sub);
    createdAccountIds.push(memex.id);

    const found = await getNamespaceBySlug(sub.toUpperCase());
    expect(found?.id).toBe(namespace.id);
  });

  it("returns undefined for unknown subdomain", async () => {
    const found = await getNamespaceBySlug("definitely-does-not-exist-xyz");
    expect(found).toBeUndefined();
  });
});

describe("getMemexById", () => {
  it("finds a memex by UUID", async () => {
    const { memex } = await seedTuple("ById Test", uniqueSubdomain("byid"));
    createdAccountIds.push(memex.id);

    const found = await getMemexById(memex.id);
    expect(found?.id).toBe(memex.id);
  });
});
