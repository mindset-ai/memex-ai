// spec-563 t-3 (ac-4) — the repair changes which access path the planner takes, not which
// rows qualify. That is a CLAIM, and this file is where it stops being an assumption.
//
// TWO OBLIGATIONS, and a third test whose only job is to prove the second one can fail.
//
//   1. OUTPUT IDENTITY. The rows a reader sees are the same with and without the index —
//      same lines, same order, same attribution. Rather than compare across commits (which
//      would need the fix reverted), both plans are produced in ONE run by toggling the
//      planner: index paths off reproduces the pre-fix shape, index paths on is what ships.
//      An index that changed the answer would show up here as a diff.
//
//   2. TENANT ISOLATION. Two Memexes are seeded with COLLIDING spec handles — both own a
//      `spec-1`, because handles are per-Memex and collide across every Memex. That
//      collision is not incidental: it is the exact shape of spec-396's cross-org bleed,
//      where the arm joined on the handle ALONE and one Memex's test event matched every
//      other Memex's same-numbered spec (~1.5 M rows misattributed). Reading tenant A must
//      return nothing of B's.
//
//   3. ⚠ THE ISOLATION ASSERTION IS PROVEN NON-VACUOUS. A test that cannot fail proves
//      nothing, and this Spec already contains one worked example of an assertion that
//      stayed green with its subject removed. So the third test builds a scratch view
//      carrying the PRE-0109 join (handle only, no memex_id equality), reads tenant A
//      through it, and asserts the leak IS visible. If that test ever goes green, test 2's
//      silence means nothing and both must be rewritten [std-45 cl-3, cl-4].

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq, inArray, sql } from "drizzle-orm";
import { tagAc } from "@memex-ai-ac/vitest";
import { db } from "../db/connection.js";
import {
  users,
  namespaces,
  orgs,
  orgMemberships,
  memexes,
  documents,
  testEvents,
} from "../db/schema.js";
import { createDocDraft } from "./documents.js";
import { listActivityView } from "./activity-view.js";

const AC = "mindset-prod/memex-building-itself/specs/spec-563/acs";

type Tenant = {
  userId: string;
  memexId: string;
  nsSlug: string;
  docId: string;
  handle: string;
};

const created = { users: [] as string[], memexes: [] as string[] };

async function seedTenant(tag: string, eventCount: number): Promise<Tenant> {
  // std-37: per-worker-unique so parallel workers never collide.
  const sub = `s563t3${tag}-${process.env.VITEST_WORKER_ID ?? "0"}-${Date.now().toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 6)}`.toLowerCase();

  const [u] = await db
    .insert(users)
    .values({ email: `${sub}@memex.ai`, name: `Actor ${tag}` } as typeof users.$inferInsert)
    .returning();
  created.users.push(u.id);

  const [ns] = await db.insert(namespaces).values({ slug: sub, kind: "org" }).returning();
  const [org] = await db.insert(orgs).values({ namespaceId: ns.id, name: `Test ${sub}` }).returning();
  await db.update(namespaces).set({ ownerOrgId: org.id }).where(eq(namespaces.id, ns.id));
  const [mx] = await db
    .insert(memexes)
    .values({ namespaceId: ns.id, slug: "main", name: `Test ${sub}` })
    .returning();
  created.memexes.push(mx.id);
  await db.insert(orgMemberships).values({ userId: u.id, orgId: org.id, role: "administrator" });

  const doc = await createDocDraft(mx.id, `Subject ${tag}`, `S${tag}`, "spec");
  const [docRow] = await db.select().from(documents).where(eq(documents.id, doc.id));

  // Distinct created_at per row. `ORDER BY at DESC` does not break ties, so identical
  // timestamps would make the ORDER half of "same lines, same order" untestable — the
  // comparison would flake on a detail that is not the claim.
  const base = Date.UTC(2026, 0, 1);
  await db.insert(testEvents).values(
    Array.from({ length: eventCount }, (_, j) => ({
      subjectRef: `${ns.slug}/main/specs/${docRow.handle}/acs/ac-1`,
      memexId: mx.id,
      status: "pass",
      testIdentifier: `${tag}-${j}`,
      actor: `ci-${tag}`,
      createdAt: new Date(base + j * 1000),
    })) as (typeof testEvents.$inferInsert)[],
  );

  return { userId: u.id, memexId: mx.id, nsSlug: ns.slug, docId: doc.id, handle: docRow.handle };
}

let tenantA: Tenant;
let tenantB: Tenant;

beforeAll(async () => {
  tenantA = await seedTenant("a", 25);
  tenantB = await seedTenant("b", 25);
});

afterAll(async () => {
  for (const t of [tenantA, tenantB]) {
    if (t) await db.delete(testEvents).where(eq(testEvents.memexId, t.memexId)).catch(() => {});
  }
  if (created.memexes.length)
    await db.delete(documents).where(inArray(documents.memexId, created.memexes)).catch(() => {});
  if (created.memexes.length)
    await db.delete(memexes).where(inArray(memexes.id, created.memexes)).catch(() => {});
  if (created.users.length) await db.delete(users).where(inArray(users.id, created.users)).catch(() => {});
});

describe("activity view: the repair changes the path, not the answer [spec-563 t-3]", () => {
  it("ac-4: the rows a reader sees are identical with and without the index path", async () => {
    tagAc(`${AC}/ac-4`);

    // Vacuity guard — if the fixture is empty, "identical" is trivially true (std-45 cl-4).
    const withIndex = await listActivityView(tenantA.memexId, { specRef: tenantA.docId });
    expect(withIndex.filter((r) => r.kind === "test_event").length).toBe(25);

    // The pre-fix plan shape, reproduced in the same run: with index paths off the planner
    // must fall back to scanning, which is what it did before 0146 existed.
    const withoutIndex = await db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL enable_indexscan = off`);
      await tx.execute(sql`SET LOCAL enable_bitmapscan = off`);
      await tx.execute(sql`SET LOCAL enable_indexonlyscan = off`);
      return (await tx.execute(
        sql`SELECT at, actor_user_id, actor_name, actor_raw, channel,
                   spec_ref, kind, entity_id, action, narrative, memex_id
              FROM activity_view
             WHERE memex_id = ${tenantA.memexId}
               AND spec_ref = ${tenantA.docId}
             ORDER BY at DESC
             LIMIT 200`,
      )) as unknown as Record<string, unknown>[];
    });

    // Same lines, same order, same attribution.
    expect(withoutIndex.length).toBe(withIndex.length);
    withIndex.forEach((row, i) => {
      const other = withoutIndex[i];
      expect(other.entity_id).toBe(row.entityId);
      expect(other.kind).toBe(row.kind);
      expect(other.action).toBe(row.action);
      expect(other.actor_raw).toBe(row.actorRaw);
      expect(other.memex_id).toBe(row.memexId);
      expect(new Date(other.at as string).getTime()).toBe(new Date(row.at).getTime());
    });
  });

  it("ac-4: reading one tenant returns nothing belonging to another, despite colliding handles", async () => {
    tagAc(`${AC}/ac-4`);

    // The precondition that makes this test mean anything: both Memexes really do own a
    // spec with the SAME handle. Without the collision there is nothing for a broken join
    // to confuse, and the test would pass on a view with no tenancy at all.
    expect(tenantA.handle).toBe(tenantB.handle);
    expect(tenantA.memexId).not.toBe(tenantB.memexId);

    const rowsA = await listActivityView(tenantA.memexId, { specRef: tenantA.docId });
    const eventsA = rowsA.filter((r) => r.kind === "test_event");

    expect(eventsA.length).toBe(25);
    expect(eventsA.every((r) => r.memexId === tenantA.memexId)).toBe(true);
    // B's events carry actor 'ci-b'. Not one of them may appear in A's feed.
    expect(eventsA.some((r) => r.actorRaw === "ci-b")).toBe(false);
  });

  it("ac-4: that isolation assertion is not vacuous — the pre-0109 join DOES leak", async () => {
    tagAc(`${AC}/ac-4`);

    // A scratch view carrying the join spec-396 removed: handle only, no memex_id
    // equality. This is not a hypothetical — it is what shipped in 0089 and what
    // misattributed ~1.5 M rows in production.
    const scratch = `spec563_leak_probe_${process.env.VITEST_WORKER_ID ?? "0"}`;
    await db.execute(
      sql.raw(`
        CREATE OR REPLACE VIEW ${scratch} AS
        SELECT te.created_at AS at, te.actor AS actor_raw, spec_doc.id AS spec_ref,
               spec_doc.memex_id AS memex_id
          FROM test_events te
          JOIN documents spec_doc
            ON spec_doc.handle = substring(te.subject_ref, 'specs/([^/]+)/')
           AND spec_doc.doc_type = 'spec'`),
    );

    try {
      const leaked = (await db.execute(
        sql.raw(
          `SELECT actor_raw FROM ${scratch} WHERE memex_id = '${tenantA.memexId}' AND spec_ref = '${tenantA.docId}'`,
        ),
      )) as unknown as { actor_raw: string }[];

      // If THIS is false, the fixture cannot express a leak and test 2's silence is
      // meaningless. The whole point of this file is that this line fails loudly rather
      // than a green suite implying safety it never checked.
      expect(leaked.some((r) => r.actor_raw === "ci-b")).toBe(true);
    } finally {
      await db.execute(sql.raw(`DROP VIEW IF EXISTS ${scratch}`));
    }
  });
});
