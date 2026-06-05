import { describe, it, expect, afterAll } from "vitest";
import { inArray } from "drizzle-orm";
import { db } from "../db/connection.js";
import { memexes } from "../db/schema.js";
import { createOrgWithOwner } from "./orgs.js";
import { createOrgWithMemexAndOwner } from "./__test__/seed-org.js";
import { upsertUserByEmail } from "./users.js";
import { ValidationError } from "../types/errors.js";

// t-14: deferred validation tests. Subdomain immutability is the big one — nothing in the
// API surface allows changing a subdomain post-creation, and PATCH settings explicitly
// does not accept a subdomain field. These tests lock that behavior.

const createdUserIds: string[] = [];
const createdAccountIds: string[] = [];

afterAll(async () => {
  if (createdUserIds.length) {
    await db
      .delete(memexes)
      .where(inArray(memexes.id, createdAccountIds))
      .catch(() => {});
  }
  if (createdAccountIds.length) {
    await db.delete(memexes).where(inArray(memexes.id, createdAccountIds)).catch(() => {});
  }
});

function uniqueEmail(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`;
}

// "Subdomain immutability" suite removed in t-19 of doc-15: subdomain (now
// namespace.slug) lives on a different table than the org/memex, and doc-15
// t-1 introduces a 30-day rename cooldown rather than strict immutability.
// The slug-allocation e2e suite (src/__e2e__/slug-allocation.api.test.ts)
// covers the new semantics.

describe("Account name validation / sanitization (t-14)", () => {
  it("uses subdomain-derived default when name is omitted", async () => {
    const owner = await upsertUserByEmail(uniqueEmail("nodef"));
    createdUserIds.push(owner.id);
    const sub = `named-${Date.now().toString(36)}`;
    const { memex: account, org } = await createOrgWithMemexAndOwner({
      slug: sub,
      ownerUserId: owner.id,
    });
    createdAccountIds.push(account.id);
    expect(org.name).toBe(sub.charAt(0).toUpperCase() + sub.slice(1));
  });

  it("trims whitespace from provided name before defaulting", async () => {
    const owner = await upsertUserByEmail(uniqueEmail("trim"));
    createdUserIds.push(owner.id);
    const sub = `trimmed-${Date.now().toString(36)}`;
    const { memex: account, org } = await createOrgWithMemexAndOwner({
      slug: sub,
      name: "   Spaces Around   ",
      ownerUserId: owner.id,
    });
    createdAccountIds.push(account.id);
    expect(org.name).toBe("Spaces Around");
  });

  it("falls back to subdomain default when name is only whitespace", async () => {
    const owner = await upsertUserByEmail(uniqueEmail("ws"));
    createdUserIds.push(owner.id);
    const sub = `ws-${Date.now().toString(36)}`;
    const { memex: account, org } = await createOrgWithMemexAndOwner({
      slug: sub,
      name: "    ",
      ownerUserId: owner.id,
    });
    createdAccountIds.push(account.id);
    expect(org.name).toBe(sub.charAt(0).toUpperCase() + sub.slice(1));
  });
});

describe("Reserved subdomain rejection at create time (t-14)", () => {
  const RESERVED = ["www", "api", "admin", "app", "docs", "support", "status", "blog"];

  it.each(RESERVED)("rejects reserved subdomain '%s'", async (reserved) => {
    const owner = await upsertUserByEmail(uniqueEmail(`rsv-${reserved}`));
    createdUserIds.push(owner.id);
    await expect(
      createOrgWithOwner({ slug: reserved, ownerUserId: owner.id })
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("rejects uppercase reserved name (normalized before check)", async () => {
    const owner = await upsertUserByEmail(uniqueEmail("uprsv"));
    createdUserIds.push(owner.id);
    await expect(
      createOrgWithOwner({ slug: "ADMIN", ownerUserId: owner.id })
    ).rejects.toBeInstanceOf(ValidationError);
  });
});
