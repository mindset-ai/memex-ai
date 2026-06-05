import { describe, it, expect, afterAll } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { db } from "../db/connection.js";
import { users, memexes, namespaces, orgs, orgMemberships } from "../db/schema.js";

// Local helper: seed a memex tuple. Returns memex row alongside org id.
async function seedMemexTuple(opts: { name: string; slug: string; emailDomains?: string[] }) {
  const [ns] = await db.insert(namespaces).values({ slug: opts.slug, kind: "org" }).returning();
  const [org] = await db
    .insert(orgs)
    .values({ namespaceId: ns.id, name: opts.name, emailDomains: opts.emailDomains ?? [] })
    .returning();
  await db.update(namespaces).set({ ownerOrgId: org.id }).where(eq(namespaces.id, ns.id));
  const [memex] = await db.insert(memexes).values({ namespaceId: ns.id, slug: "main", name: opts.name }).returning();
  return { memex, org, namespace: ns };
}
import {
  upsertUserByEmail,
  getUserByEmail,
  getUserById,
  listMemberships,
  listMembershipsMatchingDomain,
} from "./users.js";

const createdUserIds: string[] = [];
const createdAccountIds: string[] = [];

afterAll(async () => {
  if (createdUserIds.length) {
    await db.delete(users).where(inArray(users.id, createdUserIds)).catch(() => {});
  }
  if (createdAccountIds.length) {
    await db.delete(memexes).where(inArray(memexes.id, createdAccountIds)).catch(() => {});
  }
});

function uniqueEmail(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`;
}

function uniqueSubdomain(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`.toLowerCase();
}

describe("upsertUserByEmail", () => {
  it("creates a new user", async () => {
    const email = uniqueEmail("alice");
    const user = await upsertUserByEmail(email);
    createdUserIds.push(user.id);

    expect(user.email).toBe(email);
    expect(user.status).toBe("active");
    expect(user.id).toBeTruthy();
  });

  it("returns existing user (idempotent) and bumps updatedAt", async () => {
    const email = uniqueEmail("bob");
    const first = await upsertUserByEmail(email);
    createdUserIds.push(first.id);

    await new Promise((r) => setTimeout(r, 5));
    const second = await upsertUserByEmail(email);

    expect(second.id).toBe(first.id);
    expect(second.updatedAt.getTime()).toBeGreaterThanOrEqual(first.updatedAt.getTime());
  });

  it("normalizes email casing", async () => {
    const email = uniqueEmail("carol");
    const lower = await upsertUserByEmail(email);
    createdUserIds.push(lower.id);

    const upper = await upsertUserByEmail(email.toUpperCase());
    expect(upper.id).toBe(lower.id);
    expect(upper.email).toBe(email.toLowerCase());
  });

  it("preserves disabled status across upserts", async () => {
    const email = uniqueEmail("dave");
    const user = await upsertUserByEmail(email);
    createdUserIds.push(user.id);

    await db.update(users).set({ status: "disabled" }).where(eq(users.id, user.id));

    const reloaded = await upsertUserByEmail(email);
    expect(reloaded.status).toBe("disabled");
  });
});

describe("getUserByEmail / getUserById", () => {
  it("finds a user by email (case-insensitive)", async () => {
    const email = uniqueEmail("eve");
    const user = await upsertUserByEmail(email);
    createdUserIds.push(user.id);

    const found = await getUserByEmail(email.toUpperCase());
    expect(found?.id).toBe(user.id);
  });

  it("returns undefined for unknown email", async () => {
    const found = await getUserByEmail("nonexistent@example.com");
    expect(found).toBeUndefined();
  });

  it("finds a user by id", async () => {
    const email = uniqueEmail("frank");
    const user = await upsertUserByEmail(email);
    createdUserIds.push(user.id);

    const found = await getUserById(user.id);
    expect(found?.email).toBe(email);
  });
});

describe("listMemberships / listMembershipsMatchingDomain", () => {
  it("returns memberships joined with account info", async () => {
    const email = uniqueEmail("grace");
    const user = await upsertUserByEmail(email);
    createdUserIds.push(user.id);

    const { memex: acct, org } = await seedMemexTuple({ name: "Grace Co", slug: uniqueSubdomain("grace") });
    createdAccountIds.push(acct.id);

    await db.insert(orgMemberships).values({
      userId: user.id,
      orgId: org.id,
      role: "administrator",
    });

    const memberships = await listMemberships(user.id);
    expect(memberships).toHaveLength(1);
    expect(memberships[0].memexId).toBe(acct.id);
    // doc-15 t-11: MembershipSummary.slug carries the namespace slug. The legacy
    // fixture above casts `as any` so this property doesn't exist on the typed
    // memex row; the runtime value (if seeded properly) is fine.
    expect(memberships[0].slug).toBeTruthy();
    void acct;
    expect(memberships[0].role).toBe("administrator");
    expect(memberships[0].name).toBe("Grace Co");
  });

  it("returns only memberships whose account claims a domain", async () => {
    const email = uniqueEmail("henry");
    const user = await upsertUserByEmail(email);
    createdUserIds.push(user.id);

    const { memex: acmeAcct, org: acmeOrg } = await seedMemexTuple({
      name: "Acme",
      slug: uniqueSubdomain("acme"),
      emailDomains: ["acme.com", "acme.io"],
    });
    const { memex: betaAcct, org: betaOrg } = await seedMemexTuple({
      name: "Beta",
      slug: uniqueSubdomain("beta"),
      emailDomains: ["beta.com"],
    });
    createdAccountIds.push(acmeAcct.id, betaAcct.id);

    await db.insert(orgMemberships).values([
      { userId: user.id, orgId: acmeOrg.id, role: "member" },
      { userId: user.id, orgId: betaOrg.id, role: "administrator" },
    ]);

    const matches = await listMembershipsMatchingDomain(user.id, "acme.com");
    expect(matches).toHaveLength(1);
    expect(matches[0].memexId).toBe(acmeAcct.id);

    const noMatches = await listMembershipsMatchingDomain(user.id, "gmail.com");
    expect(noMatches).toHaveLength(0);
  });

  it("matches domain case-insensitively", async () => {
    const email = uniqueEmail("ivy");
    const user = await upsertUserByEmail(email);
    createdUserIds.push(user.id);

    const { memex: acct, org } = await seedMemexTuple({
      name: "Ivy Co",
      slug: uniqueSubdomain("ivy"),
      emailDomains: ["ivy.com"],
    });
    createdAccountIds.push(acct.id);

    await db.insert(orgMemberships).values({
      userId: user.id,
      orgId: org.id,
      role: "member",
    });

    const matches = await listMembershipsMatchingDomain(user.id, "IVY.COM");
    expect(matches).toHaveLength(1);
  });
});
