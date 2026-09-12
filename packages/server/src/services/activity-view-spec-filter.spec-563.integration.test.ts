// spec-563 t-1 (dec-1) — the regression guard for the activity footer's SPEC filter.
//
// THE DEFECT. `listActivityView(memexId, { specRef })` reads activity_view with two
// predicates. `memex_id` pushes down to test_events (it is a base column, indexed since
// spec-398's 0111). `spec_ref` does NOT: for the test_events arm `spec_ref` IS
// `spec_doc.id`, and the only link back to the table is
//
//     substring(te.subject_ref from 'specs/([^/]+)/') = spec_doc.handle
//
// with no index on that expression. So Postgres builds a hash join whose PROBE SIDE is
// the tenant's entire test_events history and discards everything that is not the
// requested Spec — measured on prod 2026-09-11 as 4 155 275 rows read to return 0, in
// 9 343 ms of a 9 347 ms query, for a Spec that has no test events at all.
//
// WHAT THIS ASSERTS, AND WHY IT IS THE ROW COUNT. The number of test_events rows the plan
// actually reads. NOT the scan type: the sequential scan visible on prod today serves the
// TENANT filter and is a defensible plan choice, so a test keyed on "Index Scan not Seq
// Scan" could be satisfied by a change that repairs nothing — and would also go green if
// someone merely forced an index onto the tenant predicate. Row count is the only signal
// that tracks the defect [spec-563 ac-2, ac-8].
//
// THE FIXTURE IS THE EMPTY-SPEC CASE ON PURPOSE. The Spec under read has ZERO test events.
// Its footer returns nothing, and today it still costs the whole tenant's history. A
// fixture where the target Spec owned rows would let a partial fix look total.
//
// ⚠ RED FIRST. Written before the index exists (std-52). It MUST fail on develop, and the
// failure output belongs on t-1. A guard that has never been red proves nothing.
//
// ⚠ SCALE CAVEAT, STATED RATHER THAN HIDDEN. At fixture scale the planner may pick a
// sequential scan even once the index exists, because scanning a few thousand rows is
// cheaper than an index descent. That would make this test fail for a reason that is not
// the defect. So the assertion runs with enable_seqscan OFF: it asks "is there an index
// this predicate CAN use", which is exactly the coupling that rots silently when the view
// text and the index expression drift apart. Whether the prod planner CHOOSES it is a
// different claim, and ac-2's before/after EXPLAIN on the real tenant is what settles it.
// Both are needed; neither substitutes for the other.

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

const AC = "mindset-prod/memex-building-itself/specs/spec-563/acs";

// Enough rows that "the whole tenant" and "this Spec's own" are unmistakably different
// numbers, and small enough that seeding stays fast.
const NOISE_SPECS = 40;
const EVENTS_PER_SPEC = 50;
const TOTAL_NOISE = NOISE_SPECS * EVENTS_PER_SPEC; // 2000

const created = {
  users: [] as string[],
  memexes: [] as string[],
  docs: [] as string[],
};

let memexId: string;
let nsSlug: string;
let emptySpecDocId: string;

beforeAll(async () => {
  // std-37: per-worker-unique identifiers so parallel workers never collide.
  const sub = `s563t1-${process.env.VITEST_WORKER_ID ?? "0"}-${Date.now().toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 6)}`.toLowerCase();

  const [u] = await db
    .insert(users)
    .values({ email: `${sub}@memex.ai`, name: "Fixture Actor" } as typeof users.$inferInsert)
    .returning();
  created.users.push(u.id);

  const [ns] = await db.insert(namespaces).values({ slug: sub, kind: "org" }).returning();
  const [org] = await db.insert(orgs).values({ namespaceId: ns.id, name: `Test ${sub}` }).returning();
  await db.update(namespaces).set({ ownerOrgId: org.id }).where(eq(namespaces.id, ns.id));
  const [mx] = await db
    .insert(memexes)
    .values({ namespaceId: ns.id, slug: "main", name: `Test ${sub}` })
    .returning();
  await db.insert(orgMemberships).values({ userId: u.id, orgId: org.id, role: "administrator" });

  memexId = mx.id;
  nsSlug = ns.slug;
  created.memexes.push(mx.id);

  // NOISE: many Specs, each carrying test events. None of these is the one we read.
  const rows: (typeof testEvents.$inferInsert)[] = [];
  for (let i = 0; i < NOISE_SPECS; i++) {
    const doc = await createDocDraft(memexId, `Noise ${i}`, `N${i}`, "spec");
    created.docs.push(doc.id);
    const [docRow] = await db.select().from(documents).where(eq(documents.id, doc.id));
    for (let j = 0; j < EVENTS_PER_SPEC; j++) {
      rows.push({
        subjectRef: `${nsSlug}/main/specs/${docRow.handle}/acs/ac-1`,
        memexId,
        status: "pass",
        testIdentifier: `noise-${i}-${j}`,
        actor: "ci-bot",
      } as typeof testEvents.$inferInsert);
    }
  }
  // Chunked insert — one 2000-row VALUES list is a needlessly large statement.
  for (let k = 0; k < rows.length; k += 250) {
    await db.insert(testEvents).values(rows.slice(k, k + 250));
  }

  // THE SUBJECT: a Spec in the same Memex with NO test events of its own.
  const empty = await createDocDraft(memexId, "The Empty Spec", "ES", "spec");
  emptySpecDocId = empty.id;
  created.docs.push(empty.id);

  // Without stats the planner is guessing, and a plan-shaped assertion on a guess is noise.
  await db.execute(sql`ANALYZE test_events`);
});

afterAll(async () => {
  await db.delete(testEvents).where(eq(testEvents.memexId, memexId)).catch(() => {});
  if (created.docs.length)
    await db.delete(documents).where(inArray(documents.id, created.docs)).catch(() => {});
  if (created.memexes.length)
    await db.delete(memexes).where(inArray(memexes.id, created.memexes)).catch(() => {});
  if (created.users.length)
    await db.delete(users).where(inArray(users.id, created.users)).catch(() => {});
});

/** Sum `Actual Rows` across every plan node reading a test_events relation (the parent or
 *  any partition). Walks the whole tree — the arm sits several levels down, under a Gather
 *  and a Hash Join, and on a partitioned table it fans out across an Append. */
function testEventRowsRead(node: Record<string, unknown>): number {
  let total = 0;
  const rel = node["Relation Name"];
  if (typeof rel === "string" && rel.startsWith("test_events")) {
    const actual = node["Actual Rows"];
    const loops = node["Actual Loops"];
    // Actual Rows is PER LOOP; a parallel node's loops are the leader plus its workers
    // sharing ONE scan, so the product is the total read, not a scan repeated.
    total += (typeof actual === "number" ? actual : 0) * (typeof loops === "number" ? loops : 1);
  }
  for (const key of ["Plans", "Plan"]) {
    const child = node[key];
    if (Array.isArray(child)) for (const c of child) total += testEventRowsRead(c as Record<string, unknown>);
    else if (child && typeof child === "object") total += testEventRowsRead(child as Record<string, unknown>);
  }
  return total;
}

describe("activity footer: the spec filter must reach test_events [spec-563 t-1]", () => {
  it("ac-8: reading one Spec's footer does not read the tenant's whole test_events history", async () => {
    tagAc(`${AC}/ac-8`);

    // ── Vacuity guard (std-45 cl-4) ─────────────────────────────────────────
    // If the seed silently did nothing, every assertion below passes for the wrong
    // reason. Prove the preconditions before proving the claim.
    const [{ count: seeded }] = (await db
      .select({ count: sql<number>`count(*)::int` })
      .from(testEvents)
      .where(eq(testEvents.memexId, memexId))) as { count: number }[];
    expect(seeded).toBe(TOTAL_NOISE);

    // postgres-js: db.execute resolves to the ROW ARRAY itself, not a { rows } wrapper.
    // Getting this wrong made the first run of this test fail on `footer.some is not a
    // function` — red, but for the test's own bug rather than for the defect. Exactly the
    // misreading a red-first discipline exists to catch: "it failed" is not "it failed
    // for the reason claimed".
    const footer = (await db.execute(
      sql`SELECT kind FROM activity_view WHERE memex_id = ${memexId} AND spec_ref = ${emptySpecDocId}`,
    )) as unknown as { kind: string }[];
    // The subject Spec owns no test events — that is the whole point of the fixture.
    expect(footer.some((r) => r.kind === "test_event")).toBe(false);

    // ── The measurement ─────────────────────────────────────────────────────
    // enable_seqscan off: see the SCALE CAVEAT in this file's header. This asks whether
    // an index exists that this predicate can use, which is the coupling that rots.
    const explained = await db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL enable_seqscan = off`);
      const rows = (await tx.execute(
        sql`EXPLAIN (ANALYZE, FORMAT JSON)
            SELECT at, actor_user_id, actor_name, actor_raw, channel,
                   spec_ref, kind, entity_id, action, narrative, memex_id
              FROM activity_view
             WHERE memex_id = ${memexId}
               AND spec_ref = ${emptySpecDocId}
             ORDER BY at DESC
             LIMIT 200`,
      )) as unknown as { "QUERY PLAN": unknown }[];
      return rows[0]["QUERY PLAN"];
    });

    const plan = (Array.isArray(explained) ? explained[0] : explained) as Record<string, unknown>;
    const rowsRead = testEventRowsRead(plan);

    // ── The claim ───────────────────────────────────────────────────────────
    // The subject Spec has ZERO test events, so a filter that reaches the table reads
    // ~nothing. Today the probe side is the tenant's whole history, so this reads
    // TOTAL_NOISE. The 10% bar is deliberately loose: it must not be satisfiable by a
    // marginal improvement, and it must not go red over a handful of rows the planner
    // touches while descending an index.
    // MEASURED: 2000 before the index (the tenant's whole history), 0 after. The bound is
    // an absolute 100 rather than the exact 0 we observe — an exact match would go red on
    // a single row touched while descending an index, which is not the defect. It is far
    // enough below TOTAL_NOISE that no partial regression can slip under it.
    expect(rowsRead).toBeLessThan(100);
  });
});
