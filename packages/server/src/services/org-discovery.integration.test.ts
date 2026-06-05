import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import { db } from "../db/connection.js";
import {
  memexes,
  namespaces,
  orgs,
  orgMemberships,
  verifiedDomains,
} from "../db/schema.js";
import { upsertUserByEmail } from "./users.js";
import {
  listDiscoverableOrgs,
  joinOrgByDomain,
  joinByDomain,
} from "./org-discovery.js";
import { ValidationError } from "../types/errors.js";

// Account-discovery depends on a slightly custom fixture: we need ORGS with
// auto_grouping_enabled + a verified_domains row pointing at them. Spin up helpers here
// rather than polluting test-helpers.ts with flow-specific setup.
//
// Returns the org.id (the unit `listDiscoverableOrgs` and friends address).
async function seedAutoGroupingAccount(prefix: string): Promise<string> {
  return seedAccount(prefix, true);
}

async function seedAccount(prefix: string, autoGroupingEnabled: boolean): Promise<string> {
  const slug = `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`.toLowerCase().slice(0, 39);
  const [ns] = await db.insert(namespaces).values({ slug, kind: "org" }).returning();
  const [org] = await db
    .insert(orgs)
    .values({ namespaceId: ns.id, name: `Test ${prefix}`, autoGroupingEnabled })
    .returning();
  await db.update(namespaces).set({ ownerOrgId: org.id }).where(eq(namespaces.id, ns.id));
  const [memex] = await db.insert(memexes).values({ namespaceId: ns.id, slug: "main", name: "Main" }).returning();
  createdMemexIds.push(memex.id);
  return org.id;
}

// Stand-in for the legacy `makeTestMemex` (returned a memex.id) — discovery
// now keys on org.id, so this helper returns the org.id and creates a memex
// with auto_grouping=false (the default).
async function makeTestMemex(prefix: string): Promise<string> {
  return seedAccount(prefix, false);
}

const createdMemexIds: string[] = [];

async function seedVerifiedDomain(domain: string, orgId: string) {
  await db
    .insert(verifiedDomains)
    .values({ domain, orgId, verificationMethod: "email" })
    .onConflictDoNothing();
}

function uniqueDomain(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 6)}.test`;
}

const createdAccountIds: string[] = []; // legacy alias — pushed by tests below
const createdDomains: string[] = [];

afterAll(async () => {
  if (createdDomains.length) {
    await db
      .delete(verifiedDomains)
      .where(inArray(verifiedDomains.domain, createdDomains))
      .catch(() => {});
  }
  for (const id of [...createdMemexIds, ...createdAccountIds]) {
    await db.delete(memexes).where(eq(memexes.id, id)).catch(() => {});
  }
});

describe("listDiscoverableOrgs", () => {
  it("returns an account when a verified domain + auto-grouping matches and the user isn't a member", async () => {
    const memexId = await seedAutoGroupingAccount("ld-match");
    createdAccountIds.push(memexId);
    const domain = uniqueDomain("match");
    createdDomains.push(domain);
    await seedVerifiedDomain(domain, memexId);

    const user = await upsertUserByEmail(`new-${Date.now()}@${domain}`);
    const results = await listDiscoverableOrgs(user.id, user.email);

    expect(results.some((r) => r.id === memexId)).toBe(true);
  });

  it("returns nothing when the email has no verified domain", async () => {
    const user = await upsertUserByEmail(
      `noone-${Date.now()}@unknown-domain.invalid`
    );
    const results = await listDiscoverableOrgs(user.id, user.email);
    expect(results).toHaveLength(0);
  });

  it("excludes memexes where the user is already ACTIVE", async () => {
    const memexId = await seedAutoGroupingAccount("ld-active");
    createdAccountIds.push(memexId);
    const domain = uniqueDomain("active");
    createdDomains.push(domain);
    await seedVerifiedDomain(domain, memexId);

    const user = await upsertUserByEmail(`active-${Date.now()}@${domain}`);
    await db.insert(orgMemberships).values({
      userId: user.id,
      orgId: memexId,
      role: "member",
      status: "active",
    } as any);

    const results = await listDiscoverableOrgs(user.id, user.email);
    expect(results.some((r) => r.id === memexId)).toBe(false);
  });

  it("still surfaces memexes where the user's membership is DISABLED (re-join path)", async () => {
    const memexId = await seedAutoGroupingAccount("ld-disabled");
    createdAccountIds.push(memexId);
    const domain = uniqueDomain("disabled");
    createdDomains.push(domain);
    await seedVerifiedDomain(domain, memexId);

    const user = await upsertUserByEmail(`dis-${Date.now()}@${domain}`);
    await db.insert(orgMemberships).values({
      userId: user.id,
      orgId: memexId,
      role: "member",
      status: "disabled",
    } as any);

    const results = await listDiscoverableOrgs(user.id, user.email);
    expect(results.some((r) => r.id === memexId)).toBe(true);
  });

  it("excludes memexes that have auto-grouping turned off even with a verified domain", async () => {
    // Account with verified domain but auto_grouping_enabled=false (default).
    const memexId = await makeTestMemex("ld-noautogroup");
    createdAccountIds.push(memexId);
    const domain = uniqueDomain("noag");
    createdDomains.push(domain);
    await seedVerifiedDomain(domain, memexId);

    const user = await upsertUserByEmail(`noag-${Date.now()}@${domain}`);
    const results = await listDiscoverableOrgs(user.id, user.email);
    expect(results.some((r) => r.id === memexId)).toBe(false);
  });
});

describe("joinOrgByDomain", () => {
  it("creates a user-role membership when the preconditions hold", async () => {
    const memexId = await seedAutoGroupingAccount("jb-ok");
    createdAccountIds.push(memexId);
    const domain = uniqueDomain("ok");
    createdDomains.push(domain);
    await seedVerifiedDomain(domain, memexId);

    const user = await upsertUserByEmail(`jb-${Date.now()}@${domain}`);
    const membership = await joinOrgByDomain(user.id, user.email, memexId);
    expect(membership.role).toBe("member");
    expect(membership.orgId).toBe(memexId);
    expect(membership.status).toBe("active");
  });

  it("reactivates a disabled membership instead of failing", async () => {
    const memexId = await seedAutoGroupingAccount("jb-re");
    createdAccountIds.push(memexId);
    const domain = uniqueDomain("re");
    createdDomains.push(domain);
    await seedVerifiedDomain(domain, memexId);

    const user = await upsertUserByEmail(`jb-re-${Date.now()}@${domain}`);
    await db.insert(orgMemberships).values({
      userId: user.id,
      orgId: memexId,
      role: "member",
      status: "disabled",
    } as any);

    const reactivated = await joinOrgByDomain(
      user.id,
      user.email,
      memexId
    );
    expect(reactivated.status).toBe("active");
  });

  it("throws ValidationError when auto-grouping is disabled", async () => {
    const memexId = await makeTestMemex("jb-off");
    createdAccountIds.push(memexId);
    const domain = uniqueDomain("off");
    createdDomains.push(domain);
    await seedVerifiedDomain(domain, memexId);

    const user = await upsertUserByEmail(`jb-off-${Date.now()}@${domain}`);
    await expect(
      joinOrgByDomain(user.id, user.email, memexId)
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("throws ValidationError when the user's email domain isn't verified for the account", async () => {
    const memexId = await seedAutoGroupingAccount("jb-mismatch");
    createdAccountIds.push(memexId);
    // Verified domain points to a DIFFERENT domain than the user's email.
    const domain = uniqueDomain("other");
    createdDomains.push(domain);
    await seedVerifiedDomain(domain, memexId);

    const user = await upsertUserByEmail(
      `mismatch-${Date.now()}@someone-else.invalid`
    );
    await expect(
      joinOrgByDomain(user.id, user.email, memexId)
    ).rejects.toBeInstanceOf(ValidationError);
  });
});

describe("joinByDomain (auto-join on signup)", () => {
  it("creates a membership when the domain matches an auto-grouping account", async () => {
    const memexId = await seedAutoGroupingAccount("auto-ok");
    createdAccountIds.push(memexId);
    const domain = uniqueDomain("auto");
    createdDomains.push(domain);
    await seedVerifiedDomain(domain, memexId);

    const user = await upsertUserByEmail(`auto-${Date.now()}@${domain}`);
    const membership = await joinByDomain(user.id, user.email);
    expect(membership).not.toBeNull();
    expect(membership?.orgId).toBe(memexId);
  });

  it("returns null when no verified domain matches", async () => {
    const user = await upsertUserByEmail(
      `nomatch-${Date.now()}@unclaimed-domain.invalid`
    );
    const result = await joinByDomain(user.id, user.email);
    expect(result).toBeNull();
  });

  it("is idempotent — subsequent calls return the existing membership", async () => {
    const memexId = await seedAutoGroupingAccount("auto-idem");
    createdAccountIds.push(memexId);
    const domain = uniqueDomain("idem");
    createdDomains.push(domain);
    await seedVerifiedDomain(domain, memexId);

    const user = await upsertUserByEmail(`idem-${Date.now()}@${domain}`);
    const first = await joinByDomain(user.id, user.email);
    const second = await joinByDomain(user.id, user.email);
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(second?.id).toBe(first?.id);

    // Only one membership exists for (userId, memexId).
    const memberships = await db
      .select()
      .from(orgMemberships)
      .where(
        and(
          eq(orgMemberships.userId, user.id),
          eq(orgMemberships.orgId, memexId)
        )
      );
    expect(memberships).toHaveLength(1);
  });

  it("reactivates a disabled membership rather than creating a duplicate", async () => {
    const memexId = await seedAutoGroupingAccount("auto-reactivate");
    createdAccountIds.push(memexId);
    const domain = uniqueDomain("react");
    createdDomains.push(domain);
    await seedVerifiedDomain(domain, memexId);

    const user = await upsertUserByEmail(`react-${Date.now()}@${domain}`);
    await db.insert(orgMemberships).values({
      userId: user.id,
      orgId: memexId,
      role: "member",
      status: "disabled",
    } as any);

    const result = await joinByDomain(user.id, user.email);
    expect(result?.status).toBe("active");
  });
});
