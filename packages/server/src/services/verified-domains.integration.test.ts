import { describe, it, expect, afterAll } from "vitest";
import { inArray } from "drizzle-orm";
import { db } from "../db/connection.js";
import { eq } from "drizzle-orm";
import { memexes, namespaces, orgs, verifiedDomains } from "../db/schema.js";
import { upsertVerifiedDomain, getVerifiedDomain } from "./verified-domains.js";
import { ConflictError } from "../types/errors.js";

const createdAccountIds: string[] = [];
const createdDomains: string[] = [];

afterAll(async () => {
  if (createdDomains.length) {
    await db.delete(verifiedDomains).where(inArray(verifiedDomains.domain, createdDomains)).catch(() => {});
  }
  if (createdAccountIds.length) {
    await db.delete(memexes).where(inArray(memexes.id, createdAccountIds)).catch(() => {});
  }
});

function uniqueSubdomain(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`.toLowerCase();
}

function uniqueDomain(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}.test`;
}

// Returns org.id (verified-domains keys on org_id post-doc-15).
async function makeAccount(): Promise<string> {
  const sub = uniqueSubdomain("vd");
  const [ns] = await db.insert(namespaces).values({ slug: sub, kind: "org" }).returning();
  const [org] = await db.insert(orgs).values({ namespaceId: ns.id, name: "Test" }).returning();
  await db.update(namespaces).set({ ownerOrgId: org.id }).where(eq(namespaces.id, ns.id));
  const [acct] = await db.insert(memexes).values({ namespaceId: ns.id, slug: "main", name: "Test" }).returning();
  createdAccountIds.push(acct.id);
  return org.id;
}

describe("upsertVerifiedDomain", () => {
  it("creates a verification when none exists", async () => {
    const memexId = await makeAccount();
    const domain = uniqueDomain("create");
    createdDomains.push(domain);

    const result = await upsertVerifiedDomain(domain, memexId, "sso");
    expect(result.domain).toBe(domain);
    expect(result.orgId).toBe(memexId);
    expect(result.verificationMethod).toBe("sso");
  });

  it("is idempotent for the same account — refreshes verifiedAt", async () => {
    const memexId = await makeAccount();
    const domain = uniqueDomain("idem");
    createdDomains.push(domain);

    const first = await upsertVerifiedDomain(domain, memexId, "sso");
    await new Promise((r) => setTimeout(r, 5));
    const second = await upsertVerifiedDomain(domain, memexId, "sso");

    expect(second.domain).toBe(first.domain);
    expect(second.verifiedAt.getTime()).toBeGreaterThanOrEqual(first.verifiedAt.getTime());
  });

  it("can update method (e.g. email → sso) for the same account", async () => {
    const memexId = await makeAccount();
    const domain = uniqueDomain("method");
    createdDomains.push(domain);

    await upsertVerifiedDomain(domain, memexId, "email");
    const updated = await upsertVerifiedDomain(domain, memexId, "sso");
    expect(updated.verificationMethod).toBe("sso");
  });

  it("throws ConflictError when a different account tries to claim the same domain (dec-5)", async () => {
    const account1 = await makeAccount();
    const account2 = await makeAccount();
    const domain = uniqueDomain("conflict");
    createdDomains.push(domain);

    await upsertVerifiedDomain(domain, account1, "sso");
    await expect(upsertVerifiedDomain(domain, account2, "sso")).rejects.toBeInstanceOf(
      ConflictError
    );
  });

  it("normalizes domain casing", async () => {
    const memexId = await makeAccount();
    const domain = uniqueDomain("case");
    createdDomains.push(domain);

    await upsertVerifiedDomain(domain.toUpperCase(), memexId, "sso");
    const found = await getVerifiedDomain(domain);
    expect(found?.domain).toBe(domain);
  });
});
