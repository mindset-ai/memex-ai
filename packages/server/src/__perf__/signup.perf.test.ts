import { describe, it, expect, afterAll } from "vitest";
import { inArray, eq } from "drizzle-orm";
import { db } from "../db/connection.js";
import { namespaces, users, orgMemberships } from "../db/schema.js";
import { createOrgWithOwner } from "../services/orgs.js";
import { upsertUserByEmail } from "../services/users.js";
import { ConflictError } from "../types/errors.js";

// Unique subdomain per test file run — shared prefix keeps cleanup cheap.
const RUN = `p1-${Date.now().toString(36)}`;

const namespaceIds: string[] = [];
const userIds: string[] = [];

afterAll(async () => {
  if (namespaceIds.length) {
    // Deleting the namespace cascades to org / memex / membership rows.
    await db.delete(namespaces).where(inArray(namespaces.id, namespaceIds)).catch(() => {});
  }
  if (userIds.length) {
    await db.delete(users).where(inArray(users.id, userIds)).catch(() => {});
  }
});

describe("perf: concurrent signups", () => {
  it("100 concurrent signups with unique subdomains all succeed", async () => {
    const N = 100;
    const owner = await upsertUserByEmail(`${RUN}-unique-owner@perf.test`);
    userIds.push(owner.id);

    const results = await Promise.allSettled(
      Array.from({ length: N }, (_, i) =>
        createOrgWithOwner({
          slug: `${RUN}-u${i}`,
          name: `Acct ${i}`,
          ownerUserId: owner.id,
        })
      )
    );

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(fulfilled).toHaveLength(N);
    expect(rejected).toHaveLength(0);

    for (const r of fulfilled) {
      if (r.status === "fulfilled") namespaceIds.push(r.value.namespace.id);
    }

    // All 100 memberships materialized — the transaction wrote both rows atomically.
    const memberships = await db
      .select({ id: orgMemberships.id })
      .from(orgMemberships)
      .where(eq(orgMemberships.userId, owner.id));
    expect(memberships.length).toBeGreaterThanOrEqual(N);
  }, 30_000);

  it("50 concurrent signups with the same slug: exactly 1 wins, 49 ConflictError", async () => {
    const sub = `${RUN}-race`;
    const N = 50;

    // Each attempt must come from a distinct owner — createOrgWithOwner writes
    // a (account, membership) pair, and memberships have a PK. Using one owner would
    // race the PK collision too, muddying the signal we're testing.
    const owners = await Promise.all(
      Array.from({ length: N }, (_, i) => upsertUserByEmail(`${RUN}-race-o${i}@perf.test`))
    );
    userIds.push(...owners.map((o) => o.id));

    const results = await Promise.allSettled(
      owners.map((o) =>
        createOrgWithOwner({ slug: sub, name: "Race", ownerUserId: o.id })
      )
    );

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const conflicts = results.filter(
      (r) => r.status === "rejected" && r.reason instanceof ConflictError
    );
    expect(fulfilled).toHaveLength(1);
    expect(conflicts).toHaveLength(N - 1);

    // Winner's namespace is tracked for cleanup.
    for (const r of fulfilled) {
      if (r.status === "fulfilled") namespaceIds.push(r.value.namespace.id);
    }
  }, 30_000);
});
