// spec-398 — bounded retention + durable tenancy for test_events.
//
// Verifies the implementation ACs end-to-end against a real Postgres (the
// per-worker migrated test DB). TAGGED with tagAc → reports to the prod memex
// (MEMEX_EMIT_KEY from the repo-root .env); emission is ON by design.
//
//   ac-1  trim-on-write caps a pair at the latest 10 (11th drops the oldest)
//   ac-2  retention is by COUNT not age
//   ac-4  the keep-last-10 invariant (what the rewrite-and-swap enforces)
//   ac-7  pruning test_events never reduces test_event_latest.run_count
//   ac-8  memex_id is stamped at write from the resolved Memex
//   ac-9  NO RLS on test_events / test_event_latest (that is spec-399)
//   ac-10 verification (reads test_event_latest) is unaffected by retention
//   ac-11 activity_view filters te.memex_id — no ac_uid tenancy parse, indexable
//   ac-12 activity_view returns the same test_event rows, tenant-scoped

import { describe, it, expect, beforeAll } from "vitest";
import { eq, and, sql } from "drizzle-orm";
import { tagAc } from "@memex-ai-ac/vitest";
import { db } from "../db/connection.js";
import {
  namespaces,
  memexes,
  testEvents,
  testEventLatest,
  acFirstVerified,
} from "../db/schema.js";
import { makeTestMemex, seedTestEvent } from "./test-helpers.js";
import { createDocDraft } from "./documents.js";
import { listActivityView } from "./activity-view.js";
import {
  trimTestEventsForPair,
  recordFirstVerified,
  RETENTION_KEEP,
} from "./test-event-retention.js";
import { deriveVerificationState } from "./acs.js";

const AC = "mindset-prod/memex-building-itself/specs/spec-398/acs";

let memexId: string;
let nsSlug: string;
let specHandle: string;
let specId: string;

// Build an ac_uid under this test's seeded memex + spec.
function ref(seq: number): string {
  return `${nsSlug}/main/specs/${specHandle}/acs/ac-${seq}`;
}

// Insert raw test_events for a pair with controlled timestamps, BYPASSING
// trim-on-write — to set up "more than 10 already exist" scenarios.
async function insertRaw(
  subjectRef: string,
  testIdentifier: string | null,
  createdAts: Date[],
): Promise<void> {
  await db.insert(testEvents).values(
    createdAts.map((createdAt) => ({
      subjectRef,
      memexId,
      status: "pass" as const,
      testIdentifier,
      createdAt,
    })),
  );
}

async function countFor(subjectRef: string, testIdentifier: string | null): Promise<number> {
  const rows = await db
    .select({ id: testEvents.id })
    .from(testEvents)
    .where(
      and(
        eq(testEvents.subjectRef, subjectRef),
        eq(sql`coalesce(${testEvents.testIdentifier}, '')`, testIdentifier ?? ""),
      ),
    );
  return rows.length;
}

beforeAll(async () => {
  memexId = await makeTestMemex("s398");
  const [row] = await db
    .select({ mx: memexes.slug, ns: namespaces.slug })
    .from(memexes)
    .innerJoin(namespaces, eq(memexes.namespaceId, namespaces.id))
    .where(eq(memexes.id, memexId));
  nsSlug = row.ns;
  const doc = await createDocDraft(memexId, "Retention spec", "x", "spec");
  specId = doc.id;
  specHandle = doc.handle!;
});

describe("spec-398 retention + tenancy", () => {
  it("ac-5: trim-on-write caps a pair at the latest 10; the 11th drops the oldest", async () => {
    tagAc(`${AC}/ac-5`);
    const subjectRef = ref(1);
    const tid = "tests/a.test.ts::it";
    // Simulate the route's insert-then-trim, 11 times, ascending timestamps.
    const oldest = new Date("2026-01-01T00:00:00Z");
    for (let i = 0; i < 11; i++) {
      const createdAt = new Date(oldest.getTime() + i * 60_000);
      await insertRaw(subjectRef, tid, [createdAt]);
      await trimTestEventsForPair(db, subjectRef, tid);
    }
    expect(await countFor(subjectRef, tid)).toBe(RETENTION_KEEP);
    // The oldest (i=0) must be gone; the newest survives.
    const survivors = await db
      .select({ createdAt: testEvents.createdAt })
      .from(testEvents)
      .where(eq(testEvents.subjectRef, subjectRef));
    const times = survivors.map((s) => s.createdAt.getTime()).sort((a, b) => a - b);
    expect(times[0]).toBe(oldest.getTime() + 1 * 60_000); // i=1 is now the oldest kept
    expect(times).not.toContain(oldest.getTime());
  });

  it("ac-4 / ac-6: keep the latest 10 by COUNT regardless of age (the rewrite-and-swap invariant)", async () => {
    tagAc(`${AC}/ac-4`);
    tagAc(`${AC}/ac-6`);
    const subjectRef = ref(2);
    const tid = "tests/b.test.ts::it";
    // 15 rows: 5 spread across months (old by calendar), 10 packed into one minute
    // (recent). Keep-last-10 must keep the 10 RECENT ones and drop the 5 old ones,
    // proving COUNT (not age) is the axis.
    const old5 = [0, 1, 2, 3, 4].map(
      (m) => new Date(Date.UTC(2025, m, 1, 0, 0, 0)),
    );
    const recent10 = Array.from(
      { length: 10 },
      (_, i) => new Date(Date.UTC(2026, 5, 24, 12, 0, i)),
    );
    await insertRaw(subjectRef, tid, [...old5, ...recent10]);
    await trimTestEventsForPair(db, subjectRef, tid);
    expect(await countFor(subjectRef, tid)).toBe(10);
    const survivors = await db
      .select({ createdAt: testEvents.createdAt })
      .from(testEvents)
      .where(eq(testEvents.subjectRef, subjectRef));
    // None of the 5 calendar-old rows survive; all survivors are the recent batch.
    for (const s of survivors) {
      expect(s.createdAt.getUTCFullYear()).toBe(2026);
    }
  });

  it("ac-7: pruning test_events never reduces test_event_latest.run_count", async () => {
    tagAc(`${AC}/ac-7`);
    const subjectRef = ref(7);
    const tid = "tests/c.test.ts::it";
    // seedTestEvent upserts the summary (run_count++) without trimming, 12 times.
    for (let i = 0; i < 12; i++) {
      await seedTestEvent({
        subjectRef,
        status: "pass",
        testIdentifier: tid,
        createdAt: new Date(Date.UTC(2026, 5, 24, 12, 0, i)),
      });
    }
    const [before] = await db
      .select({ runCount: testEventLatest.runCount })
      .from(testEventLatest)
      .where(
        and(eq(testEventLatest.subjectRef, subjectRef), eq(testEventLatest.testIdentifier, tid)),
      );
    expect(before.runCount).toBe(12);
    // Now prune the log to 10.
    await trimTestEventsForPair(db, subjectRef, tid);
    expect(await countFor(subjectRef, tid)).toBe(10);
    const [after] = await db
      .select({ runCount: testEventLatest.runCount })
      .from(testEventLatest)
      .where(
        and(eq(testEventLatest.subjectRef, subjectRef), eq(testEventLatest.testIdentifier, tid)),
      );
    // run_count is the incremental all-time counter — pruning the log can't touch it.
    expect(after.runCount).toBe(12);
  });

  it("ac-9 / ac-2: memex_id is stamped at write from the resolved Memex", async () => {
    tagAc(`${AC}/ac-9`);
    tagAc(`${AC}/ac-2`);
    const subjectRef = ref(8);
    await seedTestEvent({ subjectRef, status: "pass", testIdentifier: "t8" });
    const [te] = await db
      .select({ memexId: testEvents.memexId })
      .from(testEvents)
      .where(eq(testEvents.subjectRef, subjectRef))
      .limit(1);
    expect(te.memexId).toBe(memexId);
    const [tel] = await db
      .select({ memexId: testEventLatest.memexId })
      .from(testEventLatest)
      .where(eq(testEventLatest.subjectRef, subjectRef))
      .limit(1);
    expect(tel.memexId).toBe(memexId);
    // first-verified snapshot recorded too.
    // spec-520 dec-7 option C: the snapshot now carries the tenant too, so the writer takes
    // the memexId. The assertion below gains a tenancy check for the same reason the row
    // gained the column — this table used to be scoped purely by ref string.
    await recordFirstVerified(db, subjectRef, new Date(Date.UTC(2026, 0, 1)), memexId);
    const [fv] = await db
      .select({ at: acFirstVerified.firstVerifiedAt, memexId: acFirstVerified.memexId })
      .from(acFirstVerified)
      .where(eq(acFirstVerified.subjectRef, subjectRef));
    expect(fv!.memexId).toBe(memexId);
    expect(fv).toBeDefined();
  });

  it("ac-10: NO row-level security on test_events / test_event_latest (spec-399 owns RLS)", async () => {
    tagAc(`${AC}/ac-10`);
    const rows = (await db.execute(sql`
      SELECT relname, relrowsecurity
      FROM pg_class
      WHERE relname IN ('test_events', 'test_event_latest')
    `)) as unknown as Array<{ relname: string; relrowsecurity: boolean }>;
    expect(rows.length).toBe(2);
    for (const r of rows) {
      expect(r.relrowsecurity, `${r.relname} must not have RLS in spec-398`).toBe(false);
    }
  });

  it("ac-8: verification (reads test_event_latest) is unaffected by retention", async () => {
    tagAc(`${AC}/ac-8`);
    const subjectRef = ref(10);
    const tid = "tests/d.test.ts::it";
    for (let i = 0; i < 12; i++) {
      await seedTestEvent({
        subjectRef,
        status: "pass",
        testIdentifier: tid,
        createdAt: new Date(Date.UTC(2026, 5, 24, 12, 0, i)),
      });
    }
    await trimTestEventsForPair(db, subjectRef, tid); // prune log to 10
    const [tel] = await db
      .select({
        testIdentifier: testEventLatest.testIdentifier,
        latestStatus: testEventLatest.latestStatus,
        latestRunAt: testEventLatest.latestRunAt,
        runCount: testEventLatest.runCount,
      })
      .from(testEventLatest)
      .where(eq(testEventLatest.subjectRef, subjectRef));
    // The verification source row is intact, so the derived state is still 'verified'.
    const state = deriveVerificationState(
      [
        {
          testIdentifier: tel.testIdentifier,
          latestStatus: tel.latestStatus as "pass" | "fail" | "error",
          latestRunAt: tel.latestRunAt,
          runCount: tel.runCount,
        },
      ],
      0,
      false,
    );
    expect(state).toBe("verified");
  });

  it("ac-11 / ac-1: activity_view filters te.memex_id — no ac_uid tenancy parse; indexable (no full scan)", async () => {
    tagAc(`${AC}/ac-11`);
    tagAc(`${AC}/ac-1`);
    const viewdef = (await db.execute(sql`
      SELECT pg_get_viewdef('activity_view', true) AS def
    `)) as unknown as Array<{ def: string }>;
    const def = viewdef[0].def;
    // The test_events arm reads the stored column…
    expect(def).toContain("te.memex_id");
    // …and no longer parses the ac_uid prefix into namespaces→memexes for tenancy
    // (split_part was ONLY used for that join, removed in spec-398).
    expect(def).not.toContain("split_part");
    // The predicate is indexable: forcing seqscan off, the per-Spec feed query can
    // ride the memex_id index rather than a full table scan.
    // SET LOCAL only persists for the current transaction, so the SET and the
    // EXPLAIN must share one — otherwise enable_seqscan resets between statements
    // and the planner is free to pick a seq scan on the tiny test table.
    const planText = await db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL enable_seqscan = off`);
      const plan = (await tx.execute(sql`
        EXPLAIN SELECT at, spec_ref, kind, memex_id FROM activity_view
        WHERE memex_id = ${memexId} AND spec_ref = ${specId}
        ORDER BY at DESC LIMIT 50
      `)) as unknown as Array<Record<string, string>>;
      return plan.map((r) => Object.values(r)[0]).join("\n");
    });
    expect(planText).toContain("test_events_memex_id_created_at_idx");
  });

  it("ac-12 / ac-3: activity_view returns the same test_event entries, tenant-scoped to its memex", async () => {
    tagAc(`${AC}/ac-12`);
    tagAc(`${AC}/ac-3`);
    const subjectRef = `${nsSlug}/main/specs/${specHandle}/acs/ac-12`;
    await seedTestEvent({ subjectRef, status: "pass", testIdentifier: "t12" });
    // The event surfaces in ITS memex's feed for ITS spec…
    const rows = await listActivityView(memexId, { specRef: specId });
    const te = rows.find((r) => r.kind === "test_event");
    expect(te, "test_event must appear in its own memex's activity").toBeDefined();
    expect(te!.memexId).toBe(memexId);
    expect(te!.specRef).toBe(specId);
    // …and a DIFFERENT memex never sees it (column-based isolation).
    const otherMemexId = await makeTestMemex("s398b");
    const otherRows = await listActivityView(otherMemexId, {});
    expect(otherRows.some((r) => r.kind === "test_event" && r.memexId === memexId)).toBe(
      false,
    );
  });
});
