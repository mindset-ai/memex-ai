// Test helpers for tenancy-scoped service tests. Each test makes a unique namespace +
// org + memex tuple and passes the memex.id to all service calls. Cleanup deletes the
// namespace, which cascades to org/memex/memberships.

import { eq } from "drizzle-orm";
import { db } from "../db/connection.js";
import { namespaces, orgs, memexes, orgMemberships, testEvents } from "../db/schema.js";
import { upsertUserByEmail } from "./users.js";
import { applyEmissionToSummary } from "./test-event-latest.js";

function uniqueSlug(prefix: string): string {
  // Slug rules per std-3: ≤39 chars, lowercase alnum + hyphens, must start with alnum.
  const tail = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  return `${prefix}-${tail}`.toLowerCase().slice(0, 39);
}

export interface SeedTestEventInput {
  acUid: string;
  status: "pass" | "fail" | "error";
  /** Defaults to null (the "no test_identifier" case), keyed as '' in the summary. */
  testIdentifier?: string | null;
  /** Defaults to server now(). Pass a past date to exercise stale / out-of-order paths. */
  createdAt?: Date;
  hidden?: boolean;
}

/**
 * Seed a test_events row the way the real emission route does (spec-162):
 * insert the log row AND maintain the test_event_latest summary in ONE
 * transaction. Integration tests that assert on the badge read paths
 * (aggregateAcHealthForBriefs / listAcsForBriefWithVerification) must seed via
 * this helper — a bare db.insert(testEvents) leaves the summary the reads
 * consume empty, so the AC would read as untested.
 */
export async function seedTestEvent(input: SeedTestEventInput): Promise<void> {
  const hidden = input.hidden ?? false;
  const testIdentifier =
    input.testIdentifier === undefined ? null : input.testIdentifier;
  await db.transaction(async (tx) => {
    const [row] = await tx
      .insert(testEvents)
      .values({
        acUid: input.acUid,
        status: input.status,
        testIdentifier,
        hidden,
        ...(input.createdAt ? { createdAt: input.createdAt } : {}),
      })
      .returning({ createdAt: testEvents.createdAt });
    await applyEmissionToSummary(tx, {
      acUid: input.acUid,
      testIdentifier,
      status: input.status,
      latestRunAt: row.createdAt,
      hidden,
    });
  });
}

// Returns the memex id.
export async function makeTestMemex(prefix = "ta"): Promise<string> {
  const slug = uniqueSlug(prefix);
  const result = await db.transaction(async (tx) => {
    const [ns] = await tx
      .insert(namespaces)
      .values({ slug, kind: "org" })
      .returning();
    const [org] = await tx
      .insert(orgs)
      .values({ namespaceId: ns.id, name: `Test ${prefix}` })
      .returning();
    await tx
      .update(namespaces)
      .set({ ownerOrgId: org.id })
      .where(eq(namespaces.id, ns.id));
    const [memex] = await tx
      .insert(memexes)
      .values({ namespaceId: ns.id, slug: "main", name: "Main" })
      .returning();
    return memex;
  });
  return result.id;
}

// Returns the memex id and the namespace slug, plus enrolls the dev user as
// administrator of the org so route-level integration tests can hit the API
// through tenant + session middleware.
export async function makeTestMemexWithDevAdmin(prefix = "ta"): Promise<{
  memexId: string;
  slug: string;
}> {
  const slug = uniqueSlug(prefix);
  const result = await db.transaction(async (tx) => {
    const [ns] = await tx
      .insert(namespaces)
      .values({ slug, kind: "org" })
      .returning();
    const [org] = await tx
      .insert(orgs)
      .values({ namespaceId: ns.id, name: `Test ${prefix}` })
      .returning();
    await tx
      .update(namespaces)
      .set({ ownerOrgId: org.id })
      .where(eq(namespaces.id, ns.id));
    const [memex] = await tx
      .insert(memexes)
      .values({ namespaceId: ns.id, slug: "main", name: "Main" })
      .returning();
    return { ns, org, memex };
  });

  const dev = await upsertUserByEmail("dev@memex.ai");
  await db
    .insert(orgMemberships)
    .values({ userId: dev.id, orgId: result.org.id, role: "administrator" })
    .onConflictDoNothing();
  return { memexId: result.memex.id, slug: result.ns.slug };
}
