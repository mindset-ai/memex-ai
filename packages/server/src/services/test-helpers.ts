// Test helpers for tenancy-scoped service tests. Each test makes a unique namespace +
// org + memex tuple and passes the memex.id to all service calls. Cleanup deletes the
// namespace, which cascades to org/memex/memberships.

import { eq } from "drizzle-orm";
import { db } from "../db/connection.js";
import { namespaces, orgs, memexes, orgMemberships, testEvents, users } from "../db/schema.js";
import { upsertUserByEmail } from "./users.js";
import { ensureUserNamespace } from "./user-namespaces.js";
import { applyEmissionToSummary } from "./test-event-latest.js";
import { applyEmissionToRollup } from "./test-run-daily.js";
import { resolveMemexId } from "./emission-keys.js";

function uniqueSlug(prefix: string): string {
  // Slug rules per std-3: ≤39 chars, lowercase alnum + hyphens, must start with alnum.
  const tail = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  return `${prefix}-${tail}`.toLowerCase().slice(0, 39);
}

export interface SeedTestEventInput {
  subjectRef: string;
  status: "pass" | "fail" | "error";
  /** Defaults to null (the "no test_identifier" case), keyed as '' in the summary. */
  testIdentifier?: string | null;
  /** Defaults to server now(). Pass a past date to exercise stale / out-of-order paths. */
  createdAt?: Date;
  hidden?: boolean;
  /**
   * spec-520 dec-8: the emission's CI provenance. The route writes these to BOTH the log row
   * and the summary, so a fixture that patches them onto the raw row afterwards produces a
   * shape production never writes — and any consumer reading the summary then sees a
   * local-only run where a CI one happened.
   */
  runId?: string | null;
  metadata?: Record<string, string> | null;
}

/**
 * Seed a test_events row the way the real emission route does: insert the log row
 * AND maintain every derived tier, in ONE transaction — test_event_latest
 * (spec-162) and, since spec-520 t-9, the per-day test_run_daily rollup.
 *
 * ALWAYS seed through this helper. A bare `db.insert(testEvents)` writes a shape
 * PRODUCTION NEVER PRODUCES: the emission route maintains all three tiers
 * together, so a raw-only row is not a smaller version of a real emission, it is
 * an impossible one. Fixtures that did it worked only for as long as the consumer
 * under test happened to read the raw log — spec-520 t-11 moved two consumers to
 * the derived tiers and two such fixtures failed immediately, which is the test
 * suite noticing a defect in itself rather than a regression in the code.
 */
export async function seedTestEvent(input: SeedTestEventInput): Promise<void> {
  const hidden = input.hidden ?? false;
  const testIdentifier =
    input.testIdentifier === undefined ? null : input.testIdentifier;
  // spec-398 ac-8: resolve the emitting Memex from the ac_uid prefix, exactly as
  // the real route does. Tests build ac_uids from a seeded memex's ns/mx slugs, so
  // this resolves; a non-resolving ac_uid means the test forgot to seed its memex.
  const [ns, mx] = input.subjectRef.split("/");
  const memexId = ns && mx ? await resolveMemexId(ns, mx) : null;
  if (!memexId) {
    throw new Error(
      `seedTestEvent: ac_uid '${input.subjectRef}' does not resolve to a memex — seed the namespace/memex first`,
    );
  }
  await db.transaction(async (tx) => {
    const [row] = await tx
      .insert(testEvents)
      .values({
        subjectRef: input.subjectRef,
        memexId,
        status: input.status,
        testIdentifier,
        hidden,
        runId: input.runId ?? null,
        metadata: input.metadata ?? null,
        ...(input.createdAt ? { createdAt: input.createdAt } : {}),
      })
      .returning({ createdAt: testEvents.createdAt });
    await applyEmissionToSummary(tx, {
      subjectRef: input.subjectRef,
      memexId,
      testIdentifier,
      status: input.status,
      latestRunAt: row.createdAt,
      hidden,
      runId: input.runId ?? null,
      metadata: input.metadata ?? null,
    });
    // spec-520 t-9: the third tier. Keep this in step with routes/test-events.ts —
    // a fixture that maintains only some of the tiers is the shape production
    // never writes, and it silently invalidates any test whose consumer reads the
    // tier the fixture skipped.
    await applyEmissionToRollup(tx, {
      subjectRef: input.subjectRef,
      memexId,
      testIdentifier,
      status: input.status,
      runAt: row.createdAt,
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

// Create a PERSONAL memex: a user-kind namespace with no owning org (spec-340 dec-7).
// Its facet-vocabulary owner resolves to the memex itself (owner_type='memex'). Used
// by the facet seeding tests to exercise the personal-memex branch.
export async function makePersonalTestMemex(prefix = "pers"): Promise<string> {
  const slug = uniqueSlug(prefix);
  const result = await db.transaction(async (tx) => {
    // A personal namespace is owner_type='user' — it MUST carry owner_user_id or it
    // violates the owner-XOR invariant (migration-smoke scans the whole table). Seed an
    // owning user so the leaked fixture row is well-formed under parallel execution.
    const [user] = await tx
      .insert(users)
      .values({ email: `${slug}@example.com` } as typeof users.$inferInsert)
      .returning();
    const [ns] = await tx
      .insert(namespaces)
      .values({ slug, kind: "user", ownerUserId: user.id })
      .returning();
    const [memex] = await tx
      .insert(memexes)
      .values({ namespaceId: ns.id, slug: "main", name: "Personal" })
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
  // upsertUserByEmail leaves users.namespace_id NULL until a session lazily
  // provisions it (ensureUserNamespace). If a beforeAll seeds the dev user but no
  // request has run yet, the migration-smoke whole-table scan (dev@memex.ai isn't
  // in its fixture-exclusion list) can catch the dev row in that null window and
  // fail under parallel scheduling (std-37). Provision it here so the fixture is
  // always well-formed. Idempotent — repairs a null/dangling pointer, no-ops when
  // the namespace already exists.
  if (!dev.namespaceId) {
    await ensureUserNamespace(dev.id);
  }
  await db
    .insert(orgMemberships)
    .values({ userId: dev.id, orgId: result.org.id, role: "administrator" })
    .onConflictDoNothing();
  return { memexId: result.memex.id, slug: result.ns.slug };
}
