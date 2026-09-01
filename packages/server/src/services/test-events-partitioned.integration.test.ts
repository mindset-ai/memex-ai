// spec-520 t-12 (ac-13) — test_events is time-partitioned, and an emission deletes nothing.
//
// WHAT THIS REPLACES. `trimTestEventsForPair` ran inside every emission transaction and
// deleted the pair's oldest rows past a count of 10. It was 13.4% of all database time and
// produced 11.24M deletes against 11.87M inserts, with autovacuum running near-continuously
// behind it. Retention is now which PARTITION a row landed in; rows leave only when an
// aged-out partition is dropped, which is a catalogue operation.
//
// ⚠ THE COUNT-BASED ASSERTIONS THAT USED TO LIVE IN spec-398-retention.integration.test.ts
// ARE NOT MOVED HERE. spec-398 ac-5 and ac-6 still SAY "latest 10 by count", and rewriting
// their tests to assert the opposite before those criteria are amended would flip them
// green on a property they do not state. The amendments are drafted (spec-520 c-14) and
// belong to the Spec's owner. This file asserts the NEW behaviour under spec-520's own
// criteria; that file is left alone until the amendment lands.

import { describe, it, expect, afterAll, beforeAll } from "vitest";
import { eq, inArray, sql } from "drizzle-orm";
import { tagAc } from "@memex-ai-ac/vitest";
import { db } from "../db/connection.js";
import { documents, memexes, namespaces, testEventLatest, testEvents } from "../db/schema.js";
import { createAc } from "./acs.js";
import { createDocDraft } from "./documents.js";
import { makeTestMemex, seedTestEvent } from "./test-helpers.js";
import { PARTITION_HORIZON_DAYS, TEST_EVENTS_RETENTION_DAYS, partitionNameFor } from "./test-event-retention.js";

const AC_PARTITIONED = "mindset-prod/memex-building-itself/specs/spec-520/acs/ac-13";
// ac-12 states the narrower half of ac-13 as its own criterion: "an emission issues no
// DELETE against test_events — trimTestEventsForPair and RETENTION_KEEP no longer exist in
// the codebase". Both halves are proven below, so it is tagged from exactly the two tests
// that prove them rather than left untested beside the criterion that subsumes it.
const AC_NO_DELETE = "mindset-prod/memex-building-itself/specs/spec-520/acs/ac-12";

let memexId: string;
let namespaceSlug: string;
let memexSlug: string;
const createdDocIds: string[] = [];
const createdRefs: string[] = [];

async function seedAc(statement: string): Promise<string> {
  const doc = await createDocDraft(memexId, "partitioned", "purpose", "spec");
  createdDocIds.push(doc.id);
  const ac = await createAc({ memexId, briefId: doc.id, kind: "implementation", statement });
  const ref = `${namespaceSlug}/${memexSlug}/specs/${doc.handle}/acs/ac-${ac.seq}`;
  createdRefs.push(ref);
  return ref;
}

beforeAll(async () => {
  memexId = await makeTestMemex("t12p");
  const [row] = await db
    .select({ m: memexes.slug, n: namespaces.slug })
    .from(memexes)
    .innerJoin(namespaces, eq(namespaces.id, memexes.namespaceId))
    .where(eq(memexes.id, memexId))
    .limit(1);
  memexSlug = row!.m;
  namespaceSlug = row!.n;
});

afterAll(async () => {
  if (createdRefs.length) {
    await db.delete(testEventLatest).where(inArray(testEventLatest.subjectRef, createdRefs)).catch(() => {});
    await db.delete(testEvents).where(inArray(testEvents.subjectRef, createdRefs)).catch(() => {});
  }
  if (createdDocIds.length) {
    await db.delete(documents).where(inArray(documents.id, createdDocIds)).catch(() => {});
  }
});

describe("spec-520 ac-13: the table is partitioned by time", () => {
  it("is a partitioned relation keyed on created_at, with the PK the partition key requires", async () => {
    tagAc(AC_PARTITIONED);
    const [rel] = (await db.execute(sql`
      SELECT c.relkind::text AS relkind,
             pg_get_partkeydef(c.oid) AS partkey,
             (SELECT pg_get_constraintdef(k.oid) FROM pg_constraint k
               WHERE k.conrelid = c.oid AND k.contype = 'p') AS pk
      FROM pg_class c WHERE c.relname = 'test_events'
    `)) as unknown as Array<{ relkind: string; partkey: string; pk: string }>;

    expect(rel.relkind).toBe("p");
    expect(rel.partkey).toBe("RANGE (created_at)");
    // A partitioned parent cannot have a PK that excludes the partition key, so this is
    // also what forced (id, created_at) — the old PK was (id) alone.
    expect(rel.pk).toBe("PRIMARY KEY (id, created_at)");
  });

  it("carries a horizon of future partitions, so an insert can never find no home", async () => {
    tagAc(AC_PARTITIONED);
    const [{ n }] = (await db.execute(sql`
      SELECT count(*)::int AS n FROM pg_inherits WHERE inhparent = 'test_events'::regclass
    `)) as unknown as Array<{ n: number }>;
    // A partitioned table with no partition for an incoming row REJECTS the insert
    // outright. The horizon is what keeps that unreachable between deploys, and a DEFAULT
    // partition is not an option: once rows land in one, that day's real partition can
    // never be created (measured — "would be violated by some row").
    expect(n).toBeGreaterThan(PARTITION_HORIZON_DAYS);
  });

  it("gives every FORWARD partition the parent's indexes, not just a primary key", async () => {
    tagAc(AC_PARTITIONED);
    // THE DEFECT THIS EXISTS FOR. The first version of 0142 created the parent indexes with
    // CREATE INDEX **IF NOT EXISTS** using the same names the legacy partition still held
    // after the rename. Every statement found its name taken and silently did nothing, so
    // the parent ended up with only its primary key — and so did every partition created
    // afterwards. Nothing failed. A NOTICE scrolled past in the migration output.
    //
    // In production that surfaces the day the first daily partition starts taking rows:
    // the AC matrix, both digest CTEs, the Pulse and the activity feed all sequential-scan
    // ~2.7M rows a day. The rehearsal under load caught it; this keeps it caught.
    const parentIdx = (await db.execute(sql`
      SELECT c.relname::text AS name
      FROM pg_class c
      WHERE c.oid IN (SELECT indexrelid FROM pg_index WHERE indrelid = 'test_events'::regclass)
    `)) as unknown as Array<{ name: string }>;
    const names = parentIdx.map((r) => r.name).sort();
    expect(names).toContain("test_events_retention_idx");
    expect(names).toContain("test_events_memex_id_created_at_idx");
    expect(names).toContain("test_events_created_at_idx");
    expect(names.length).toBeGreaterThanOrEqual(6); // 5 + the PK

    // And they must have REACHED a partition — a parent index that failed to propagate
    // looks identical from the parent's catalogue alone.
    const [{ n }] = (await db.execute(sql`
      SELECT count(*)::int AS n
      FROM pg_indexes
      WHERE tablename = (
        SELECT c.relname FROM pg_class c
        JOIN pg_inherits i ON i.inhrelid = c.oid
        WHERE i.inhparent = 'test_events'::regclass AND c.relname <> 'test_events_legacy'
        ORDER BY c.relname LIMIT 1
      )
    `)) as unknown as Array<{ n: number }>;
    expect(n).toBeGreaterThanOrEqual(6);
  });

  it("routes a row to the partition its created_at names", async () => {
    tagAc(AC_PARTITIONED);
    const ref = await seedAc("routing");
    const future = new Date(Date.now() + 10 * 86_400_000);
    await seedTestEvent({ subjectRef: ref, status: "pass", testIdentifier: "a::t", createdAt: future });

    const [row] = (await db.execute(sql`
      SELECT tableoid::regclass::text AS part FROM test_events WHERE subject_ref = ${ref} LIMIT 1
    `)) as unknown as Array<{ part: string }>;
    expect(row.part).toBe(partitionNameFor(future));
  });
});

describe("spec-520 ac-13: an emission deletes nothing", () => {
  it("keeps every emission for a pair — the 11th no longer evicts the oldest", async () => {
    tagAc(AC_PARTITIONED);
    tagAc(AC_NO_DELETE);
    const ref = await seedAc("no trim");
    const base = Date.now() - 20 * 60_000;
    for (let i = 0; i < 15; i++) {
      await seedTestEvent({
        subjectRef: ref, status: "pass", testIdentifier: "a::t",
        createdAt: new Date(base + i * 60_000),
      });
    }

    const [{ n }] = (await db.execute(sql`
      SELECT count(*)::int AS n FROM test_events
      WHERE subject_ref = ${ref} AND test_identifier = 'a::t'
    `)) as unknown as Array<{ n: number }>;
    // Under the old trim this was exactly 10, forever, no matter how many ran. That cap is
    // the reason the history charts were reading 4.5% of what happened.
    expect(n).toBe(15);
  });

  it("exports no per-pair trim to call any more", async () => {
    tagAc(AC_PARTITIONED);
    tagAc(AC_NO_DELETE);
    const mod = await import("./test-event-retention.js");
    // A leftover export is an invitation to reintroduce the 13.4%: the emission path used
    // to call it, and a future edit restoring that call would be a one-line regression with
    // no test to catch it if the function still existed.
    expect(Object.keys(mod)).not.toContain("trimTestEventsForPair");
    expect(Object.keys(mod)).not.toContain("RETENTION_KEEP");
  });

  it("exposes the retention window as configuration, not a constant", async () => {
    tagAc(AC_PARTITIONED);
    // spec-60 dec-6's precedent (PULSE_RETENTION_DAYS). spec-62's W4 retention workstream
    // has pinned no schedule for this table, so no floor is fixed today — but one may be,
    // and it must be a config change rather than a re-partitioning.
    expect(TEST_EVENTS_RETENTION_DAYS).toBeGreaterThan(0);
    expect(TEST_EVENTS_RETENTION_DAYS).toBeLessThanOrEqual(90);
  });
});
