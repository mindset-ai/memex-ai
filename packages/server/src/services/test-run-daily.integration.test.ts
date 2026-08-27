// Integration tests for the test_run_daily rollup (spec-520 dec-5 / t-9).
//
// DB-backed by necessity, for the same reason its sibling
// test-event-latest.integration.test.ts is: everything load-bearing here is
// SQL-level — the ON CONFLICT arithmetic, the composite PK, the CHECK invariant,
// and the absence of an index on the count columns. A unit test on the helper
// would assert the values we passed in, not what Postgres stored.
//
// Tagged to spec-520 ac-21. NOT tagged to ac-22 (RLS on the rollup): that half
// is deliberately unbuilt and gated on issue-8 — the emission WRITE transaction
// does not run inside runWithMemexId, so a policy on this table would be
// unsatisfiable at write time in prod. Tagging ac-22 from here would flip it
// green on a property this file does not test.

import { describe, it, expect, afterAll, beforeAll } from "vitest";
import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "../db/connection.js";
import { testRunDaily } from "../db/schema.js";
import { applyEmissionToRollup, utcDayFor } from "./test-run-daily.js";
import { makeTestMemex } from "./test-helpers.js";
import { tagAc } from "@memex-ai-ac/vitest";

const AC_21 = "mindset-prod/memex-building-itself/specs/spec-520/acs/ac-21";

let memexId: string;
// std-37: per-worker-unique identifiers, so parallel workers never collide on
// the same rollup key.
const RUN_TAG = `t9-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
const createdRefs: string[] = [];

function refFor(name: string): string {
  const ref = `mindset-prod/fixture/specs/spec-1/acs/${RUN_TAG}-${name}`;
  createdRefs.push(ref);
  return ref;
}

beforeAll(async () => {
  memexId = await makeTestMemex("trd");
});

afterAll(async () => {
  if (createdRefs.length) {
    await db
      .delete(testRunDaily)
      .where(inArray(testRunDaily.subjectRef, createdRefs))
      .catch(() => {});
  }
});

async function rowsFor(subjectRef: string) {
  return db
    .select()
    .from(testRunDaily)
    .where(and(eq(testRunDaily.subjectRef, subjectRef), eq(testRunDaily.memexId, memexId)));
}

describe("test_run_daily — the shape ac-21 claims", () => {
  it("is keyed on (memex_id, subject_ref, test_identifier, day) and carries the four counts", async () => {
    tagAc(AC_21);

    const [pk] = await db.execute(sql`
      SELECT array_agg(a.attname ORDER BY k.ord) AS cols
        FROM pg_constraint c
        JOIN LATERAL unnest(c.conkey) WITH ORDINALITY AS k(attnum, ord) ON TRUE
        JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum
       WHERE c.conrelid = 'test_run_daily'::regclass AND c.contype = 'p'
    `);
    expect((pk as { cols: string[] }).cols).toEqual([
      "memex_id",
      "subject_ref",
      "test_identifier",
      "day",
    ]);

    const cols = await db.execute(sql`
      SELECT column_name FROM information_schema.columns
       WHERE table_name = 'test_run_daily'
    `);
    const names = (cols as unknown as { column_name: string }[]).map((r) => r.column_name);
    expect(names).toEqual(
      expect.arrayContaining(["run_count", "pass_count", "fail_count", "error_count"]),
    );
  });

  it("keeps every count column UNINDEXED so increments stay HOT [per std-39 cl-7]", async () => {
    tagAc(AC_21);

    // The guard that matters: an index on a counter defeats HOT updates, so
    // every one of ~227k daily increments would also write an index tuple and
    // hand autovacuum the dead tuples to chase. Assert on the columns actually
    // indexed rather than on index count, so adding a legitimate key-column
    // index later doesn't fail this test spuriously.
    const indexed = await db.execute(sql`
      SELECT DISTINCT a.attname
        FROM pg_index i
        JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
       WHERE i.indrelid = 'test_run_daily'::regclass
    `);
    const cols = (indexed as unknown as { attname: string }[]).map((r) => r.attname);
    for (const counter of ["run_count", "pass_count", "fail_count", "error_count"]) {
      expect(cols).not.toContain(counter);
    }
  });
});

describe("test_run_daily — one emission, exactly one upsert", () => {
  it("creates one row on the first emission and increments it in place on the next", async () => {
    tagAc(AC_21);

    const ref = refFor("increments");
    const at = new Date("2026-08-20T11:00:00.000Z");

    await applyEmissionToRollup(db, {
      subjectRef: ref,
      memexId,
      testIdentifier: "suite/a.test.ts::first",
      status: "pass",
      runAt: at,
      hidden: false,
    });

    let rows = await rowsFor(ref);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ runCount: 1, passCount: 1, failCount: 0, errorCount: 0 });

    // Same key, later in the same UTC day → still ONE row.
    await applyEmissionToRollup(db, {
      subjectRef: ref,
      memexId,
      testIdentifier: "suite/a.test.ts::first",
      status: "fail",
      runAt: new Date("2026-08-20T23:59:59.000Z"),
      hidden: false,
    });

    rows = await rowsFor(ref);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ runCount: 2, passCount: 1, failCount: 1, errorCount: 0 });
  });

  it("separates UTC days, and fixes the day from the event rather than the local clock", async () => {
    tagAc(AC_21);

    const ref = refFor("days");
    // 23:30 UTC on the 20th is the 21st in +02:00. A server-local derivation
    // would file this under the wrong day; utcDayFor must not.
    const late = new Date("2026-08-20T23:30:00.000Z");
    const next = new Date("2026-08-21T00:30:00.000Z");
    expect(utcDayFor(late)).toBe("2026-08-20");
    expect(utcDayFor(next)).toBe("2026-08-21");

    for (const at of [late, next]) {
      await applyEmissionToRollup(db, {
        subjectRef: ref,
        memexId,
        testIdentifier: "",
        status: "pass",
        runAt: at,
        hidden: false,
      });
    }

    const rows = await rowsFor(ref);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.day).sort()).toEqual(["2026-08-20", "2026-08-21"]);
  });

  it("counts each outcome in its own column, and only one per emission", async () => {
    tagAc(AC_21);

    const ref = refFor("outcomes");
    const at = new Date("2026-08-20T08:00:00.000Z");
    for (const status of ["pass", "pass", "fail", "error"] as const) {
      await applyEmissionToRollup(db, {
        subjectRef: ref,
        memexId,
        testIdentifier: "s::t",
        status,
        runAt: at,
        hidden: false,
      });
    }

    const rows = await rowsFor(ref);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ runCount: 4, passCount: 2, failCount: 1, errorCount: 1 });
  });

  it("skips hidden emissions entirely, matching applyEmissionToSummary", async () => {
    tagAc(AC_21);

    const ref = refFor("hidden");
    await applyEmissionToRollup(db, {
      subjectRef: ref,
      memexId,
      testIdentifier: "s::t",
      status: "pass",
      runAt: new Date("2026-08-20T08:00:00.000Z"),
      hidden: true,
    });
    expect(await rowsFor(ref)).toHaveLength(0);
  });

  it("collapses a null test_identifier to '' so it shares one PK slot", async () => {
    tagAc(AC_21);

    const ref = refFor("nullident");
    const at = new Date("2026-08-20T08:00:00.000Z");
    for (const testIdentifier of [null, ""]) {
      await applyEmissionToRollup(db, {
        subjectRef: ref,
        memexId,
        testIdentifier,
        status: "pass",
        runAt: at,
        hidden: false,
      });
    }
    const rows = await rowsFor(ref);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.testIdentifier).toBe("");
    expect(rows[0]!.runCount).toBe(2);
  });

  it("scopes rows by memex_id, so an identical ref under another tenant is a different row", async () => {
    tagAc(AC_21);

    const otherMemexId = await makeTestMemex("trd2");
    const ref = refFor("tenancy");
    const at = new Date("2026-08-20T08:00:00.000Z");

    for (const mid of [memexId, otherMemexId]) {
      await applyEmissionToRollup(db, {
        subjectRef: ref,
        memexId: mid,
        testIdentifier: "s::t",
        status: "pass",
        runAt: at,
        hidden: false,
      });
    }

    const all = await db
      .select()
      .from(testRunDaily)
      .where(eq(testRunDaily.subjectRef, ref));
    expect(all).toHaveLength(2);
    expect(all.every((r) => r.runCount === 1)).toBe(true);

    await db.delete(testRunDaily).where(eq(testRunDaily.subjectRef, ref)).catch(() => {});
  });
});

describe("test_run_daily — the CHECK is a wiring tripwire", () => {
  it("rejects a row whose run_count does not equal the outcome counts summed", async () => {
    tagAc(AC_21);

    const ref = refFor("check");

    // Assert on the CONSTRAINT, not on the message. Drizzle wraps the driver
    // error, so the outer message is only "Failed query: insert into …" and a
    // regex against it passes for any failure at all — including the table not
    // existing. The postgres-js error carries `constraint_name` on the cause,
    // which is the only thing that proves THIS check fired.
    const err = await db
      .insert(testRunDaily)
      .values({
        memexId,
        subjectRef: ref,
        testIdentifier: "s::t",
        day: "2026-08-20",
        runCount: 5,
        passCount: 1,
        failCount: 0,
        errorCount: 0,
      })
      .then(
        () => null,
        (e: unknown) => e,
      );

    expect(err).not.toBeNull();
    const cause = (err as { cause?: { constraint_name?: string; code?: string } }).cause;
    expect(cause?.constraint_name).toBe("test_run_daily_counts_sum");
    // 23514 = check_violation. Pins that the row was refused by the CHECK
    // rather than by the PK, a NOT NULL, or a type error.
    expect(cause?.code).toBe("23514");
  });
});

describe("test_run_daily — concurrent emissions for the same pair", () => {
  it("does not deadlock and loses no increment when two transactions race the same key", async () => {
    tagAc(AC_21);

    const ref = refFor("concurrent");
    const at = new Date("2026-08-20T09:00:00.000Z");

    // The failure this guards against is spec-398's: restructuring a
    // continuously-written table in this path deadlocked and rolled back a prod
    // deploy (std-39 cl-9). Both transactions take the rollup lock at the same
    // relative point, so one waits rather than cycling.
    const emit = (status: "pass" | "fail") =>
      db.transaction(async (tx) =>
        applyEmissionToRollup(tx, {
          subjectRef: ref,
          memexId,
          testIdentifier: "s::t",
          status,
          runAt: at,
          hidden: false,
        }),
      );

    const results = await Promise.allSettled([
      emit("pass"),
      emit("fail"),
      emit("pass"),
      emit("fail"),
    ]);
    const rejected = results.filter((r) => r.status === "rejected");
    expect(rejected).toEqual([]);

    const rows = await rowsFor(ref);
    expect(rows).toHaveLength(1);
    // Every increment landed — no lost update from the concurrent upserts.
    expect(rows[0]).toMatchObject({ runCount: 4, passCount: 2, failCount: 2 });
  });
});
