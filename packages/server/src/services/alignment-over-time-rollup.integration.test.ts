// spec-520 t-11 (second half) — listAcAlignmentOverTime reads the per-day rollup.
//
// THE DEFECT. This query carried a correlated subquery per (day × AC):
//
//     SELECT te.status FROM test_events te
//     WHERE te.subject_ref = a.subject_ref AND te.created_at < (s.day + INTERVAL '1 day')
//     ORDER BY te.created_at DESC LIMIT 1
//
// against a table the retention trim caps at RETENTION_KEEP=10 rows per
// (subject_ref, test_identifier). For a BUSY AC those ten rows are all from the last few
// hours, so every older day finds nothing and reads as "never verified". The bias is the
// same one that broke testRunVolume and it runs the same direction: the more an AC is
// tested, the less of its history the chart can see. Measured on prod 2026-08-18 — 65,708
// pairs sitting at exactly the cap of 10.
//
// THE PROOF SHAPE, as for ac-24's first half: seed the ROLLUP and leave the raw log EMPTY.
// Under the old implementation that is indistinguishable from "nothing ever happened",
// which is precisely the defect. Seeding raw events too would let a still-broken
// implementation pass.
//
// AND A SEMANTIC UPGRADE t-11 ASKS FOR BY NAME: derive AC-green from ALL of an AC's tests
// passing that day, not from whichever single event happened to be latest. The old read
// took one row, so a passing test could mask a sibling that went red in the same minute.
// The rollup keeps per-test counts, so the honest question is answerable for the first
// time — and the third case below is red under any "latest single event" implementation.

import { describe, it, expect, afterAll, beforeAll } from "vitest";
import { eq, inArray, sql } from "drizzle-orm";
import { tagAc } from "@memex-ai-ac/vitest";
import { db } from "../db/connection.js";
import {
  documents,
  memexes,
  namespaces,
  testEventLatest,
  testEvents,
  testRunDaily,
} from "../db/schema.js";
import { createAc, listAcAlignmentOverTime } from "./acs.js";
import { createDocDraft } from "./documents.js";
import { makeTestMemex, seedTestEvent } from "./test-helpers.js";

const AC_CHARTS = "mindset-prod/memex-building-itself/specs/spec-520/acs/ac-24";
// NOT ac-5. That criterion also claims "no behavioural change on the AC-health surfaces —
// colours, counts and verification states identical before and after", which nothing here
// exercises. Tagging it from the boundary clause alone would flip it green on a weaker
// property than it states — the ac-22/ac-32 mistake. ac-40 is the boundary clause on its
// own, and the sparkline half of it is proven in AcSparkline.boundary.test.tsx.
const AC_BOUNDARY = "mindset-prod/memex-building-itself/specs/spec-520/acs/ac-40";

let memexId: string;
let otherMemexId: string;
/** Deliberately never given a rollup row — `otherMemexId` gets one by the tenancy case. */
let emptyMemexId: string;
/**
 * The boundary cases need a Memex of their own. Coverage is min(day) across the WHOLE
 * tenant, so a row seeded by any earlier case in this file would move the boundary under
 * them — the cases would pass or fail on execution order rather than on the property.
 */
let boundaryMemexId: string;
let boundarySlug: string;
let namespaceSlug: string;
let memexSlug: string;
const createdDocIds: string[] = [];
const createdRefs: string[] = [];

async function seedBrief(): Promise<{ id: string; handle: string }> {
  const doc = await createDocDraft(memexId, "alignment rollup test", "purpose", "spec");
  createdDocIds.push(doc.id);
  return { id: doc.id, handle: doc.handle! };
}

function refOf(briefHandle: string, seq: number): string {
  const ref = `${namespaceSlug}/${memexSlug}/specs/${briefHandle}/acs/ac-${seq}`;
  createdRefs.push(ref);
  return ref;
}

/**
 * Write one rollup row. `dayOffset` counts BACK from the database's CURRENT_DATE — the
 * query anchors its series on the server clock, so the fixture has to speak the same
 * calendar rather than JS's.
 */
async function seedRollup(row: {
  ref: string;
  test: string;
  dayOffset: number;
  pass?: number;
  fail?: number;
  error?: number;
  memex?: string;
}): Promise<void> {
  const pass = row.pass ?? 0;
  const fail = row.fail ?? 0;
  const error = row.error ?? 0;
  await db.execute(sql`
    INSERT INTO test_run_daily
      (memex_id, subject_ref, test_identifier, day, run_count, pass_count, fail_count, error_count)
    VALUES (
      ${row.memex ?? memexId}::uuid, ${row.ref}, ${row.test},
      CURRENT_DATE - ${row.dayOffset}::int,
      ${pass + fail + error}, ${pass}, ${fail}, ${error}
    )
    ON CONFLICT (memex_id, subject_ref, test_identifier, day) DO UPDATE SET
      run_count = EXCLUDED.run_count, pass_count = EXCLUDED.pass_count,
      fail_count = EXCLUDED.fail_count, error_count = EXCLUDED.error_count
  `);
}

/**
 * Move an AC's createdAt back N days. The query gates `verified` on AC existence — an AC
 * created today counts toward neither total nor verified on any earlier day — so a case
 * asserting anything about the past has to put the AC in the past first.
 */
async function backdateAc(acId: string, days: number): Promise<void> {
  await db.execute(sql`
    UPDATE acs SET created_at = now() - (${days} || ' days')::interval WHERE id = ${acId}
  `);
}

beforeAll(async () => {
  memexId = await makeTestMemex("t11b");
  otherMemexId = await makeTestMemex("t11bx");
  emptyMemexId = await makeTestMemex("t11be");
  boundaryMemexId = await makeTestMemex("t11bb");
  const [row] = await db
    .select({ m: memexes.slug, n: namespaces.slug })
    .from(memexes)
    .innerJoin(namespaces, eq(namespaces.id, memexes.namespaceId))
    .where(eq(memexes.id, memexId))
    .limit(1);
  memexSlug = row!.m;
  namespaceSlug = row!.n;
  const [b] = await db
    .select({ m: memexes.slug })
    .from(memexes)
    .where(eq(memexes.id, boundaryMemexId))
    .limit(1);
  boundarySlug = b!.m;
});

afterAll(async () => {
  await db.delete(testRunDaily).where(eq(testRunDaily.memexId, memexId)).catch(() => {});
  await db.delete(testRunDaily).where(eq(testRunDaily.memexId, otherMemexId)).catch(() => {});
  await db.delete(testRunDaily).where(eq(testRunDaily.memexId, emptyMemexId)).catch(() => {});
  await db.delete(testRunDaily).where(eq(testRunDaily.memexId, boundaryMemexId)).catch(() => {});
  if (createdRefs.length) {
    await db.delete(testEventLatest).where(inArray(testEventLatest.subjectRef, createdRefs)).catch(() => {});
    await db.delete(testEvents).where(inArray(testEvents.subjectRef, createdRefs)).catch(() => {});
  }
  if (createdDocIds.length) {
    await db.delete(documents).where(inArray(documents.id, createdDocIds)).catch(() => {});
  }
});

describe("spec-520 ac-24: alignment history comes from the rollup, not the raw log", () => {
  it("reports an AC as verified from rollup counts alone, with NO raw events", async () => {
    tagAc(AC_CHARTS);
    const spec = await seedBrief();
    const ac = await createAc({
      memexId, briefId: spec.id, kind: "implementation", statement: "green from the rollup",
    });
    const ref = refOf(spec.handle, ac.seq);

    await seedRollup({ ref, test: "a::t", dayOffset: 1, pass: 3 });

    const days = await listAcAlignmentOverTime(memexId, spec.id, 7);
    const today = days.at(-1)!;
    expect(today.total).toBe(1);
    // The raw log is empty. Anything reading test_events sees zero here.
    expect(today.verified).toBe(1);
  });

  it("carries a green forward on days the AC did not run", async () => {
    tagAc(AC_CHARTS);
    const spec = await seedBrief();
    const ac = await createAc({
      memexId, briefId: spec.id, kind: "implementation", statement: "ran once, still green",
    });
    const ref = refOf(spec.handle, ac.seq);

    await backdateAc(ac.id, 5);
    // Passed three days ago and has not run since. It is still green today — "latest
    // known state", not "ran today".
    await seedRollup({ ref, test: "a::t", dayOffset: 3, pass: 2 });

    const days = await listAcAlignmentOverTime(memexId, spec.id, 7);
    expect(days.at(-1)!.verified).toBe(1);
    expect(days.at(-2)!.verified).toBe(1);
    // …and not before it ran.
    expect(days.at(-5)!.verified).toBe(0);
  });

  it("is NOT verified when one of its tests failed that day, even though another passed", async () => {
    tagAc(AC_CHARTS);
    const spec = await seedBrief();
    const ac = await createAc({
      memexId, briefId: spec.id, kind: "implementation", statement: "two tests, one red",
    });
    const ref = refOf(spec.handle, ac.seq);

    // THE SEMANTIC UPGRADE. Two tests carry this AC on the same day; one is green, one is
    // red. "Latest single event" answers whichever wrote last — a coin toss that reads
    // green half the time. An AC with a failing test is not verified.
    // The green test also gets a REAL emission, so the raw log holds a passing row and
    // nothing else. That is what makes this case discriminating rather than vacuous: a
    // "latest single event" read finds that pass and calls the AC verified. Every other
    // case here runs against an empty log, where any implementation answers zero.
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
    await seedTestEvent({
      subjectRef: ref, status: "pass", createdAt: yesterday, testIdentifier: "green::t",
    });
    await seedRollup({ ref, test: "red::t", dayOffset: 1, fail: 1 });

    const days = await listAcAlignmentOverTime(memexId, spec.id, 7);
    expect(days.at(-1)!.total).toBe(1);
    expect(days.at(-1)!.verified).toBe(0);
  });

  it("goes green again on the day the red test starts passing", async () => {
    tagAc(AC_CHARTS);
    const spec = await seedBrief();
    const ac = await createAc({
      memexId, briefId: spec.id, kind: "implementation", statement: "red then green",
    });
    const ref = refOf(spec.handle, ac.seq);

    await backdateAc(ac.id, 5);
    await seedRollup({ ref, test: "a::t", dayOffset: 2, fail: 1 });
    await seedRollup({ ref, test: "a::t", dayOffset: 1, pass: 1 });

    const days = await listAcAlignmentOverTime(memexId, spec.id, 7);
    const byOffset = (n: number) => days.at(-1 - n)!;
    expect(byOffset(2).verified).toBe(0); // still red
    expect(byOffset(1).verified).toBe(1); // fixed
    expect(byOffset(0).verified).toBe(1); // stays fixed
  });

  it("counts an errored run as not-green, the same as a failure", async () => {
    tagAc(AC_CHARTS);
    const spec = await seedBrief();
    const ac = await createAc({
      memexId, briefId: spec.id, kind: "implementation", statement: "errored",
    });
    const ref = refOf(spec.handle, ac.seq);

    await seedRollup({ ref, test: "a::t", dayOffset: 1, error: 1 });

    const days = await listAcAlignmentOverTime(memexId, spec.id, 7);
    expect(days.at(-1)!.verified).toBe(0);
  });

  it("ignores another tenant's rows carrying the very same subject_ref", async () => {
    tagAc(AC_CHARTS);
    const spec = await seedBrief();
    const ac = await createAc({
      memexId, briefId: spec.id, kind: "implementation", statement: "tenancy",
    });
    const ref = refOf(spec.handle, ac.seq);

    // The old query filtered on subject_ref ALONE — no memex_id anywhere. Tenancy carried
    // by a string is the spec-396 leak pattern this Spec closes elsewhere; a foreign row
    // claiming this ref would have decided our chart.
    await seedRollup({ ref, test: "a::t", dayOffset: 1, pass: 9, memex: otherMemexId });

    const days = await listAcAlignmentOverTime(memexId, spec.id, 7);
    expect(days.at(-1)!.verified).toBe(0);
  });
});

describe("spec-520 ac-40: the chart declares where its history actually begins", () => {
  it("marks days before the rollup's first row as unmeasured, and measured ones as measured", async () => {
    tagAc(AC_BOUNDARY);
    const doc = await createDocDraft(boundaryMemexId, "boundary", "purpose", "spec");
    createdDocIds.push(doc.id);
    const ac = await createAc({
      memexId: boundaryMemexId, briefId: doc.id, kind: "implementation", statement: "boundary",
    });
    // The real canonical ref. `measured` is a TENANT-level property — it would read true
    // off any row this Memex owns — so a made-up ref here would still pass, and would
    // quietly tell the next reader that this row is what makes the boundary.
    const ref = `${namespaceSlug}/${boundarySlug}/specs/${doc.handle}/acs/ac-${ac.seq}`;

    // The rollup ships mid-history. Every day before its first row is a day we CANNOT
    // measure — the per-day past was deleted by retention and cannot be reconstructed.
    // Rendering those as verified=0 without saying so lets a truncated past read as
    // measured absence, which is exactly what ac-5 forbids.
    await seedRollup({ ref, test: "a::t", dayOffset: 2, pass: 1, memex: boundaryMemexId });

    const days = await listAcAlignmentOverTime(boundaryMemexId, doc.id, 7);
    expect(days.at(-1)!.measured).toBe(true);
    expect(days.at(-2)!.measured).toBe(true);
    expect(days.at(-3)!.measured).toBe(true);
    // One day earlier than anything the rollup holds.
    expect(days.at(-4)!.measured).toBe(false);
    expect(days[0]!.measured).toBe(false);
  });

  it("marks every day unmeasured when the rollup holds nothing for this tenant", async () => {
    tagAc(AC_BOUNDARY);
    // A Memex whose rollup is entirely empty — a brand-new tenant, or any tenant on the
    // day the rollup ships. Its flat-zero line is not a measured absence of green; it is
    // the absence of measurement. Claiming otherwise is the same lie in its strongest
    // form, and this is the case a per-day flag derived from "is there a row" would get
    // wrong by returning nothing to flag.
    const doc = await createDocDraft(emptyMemexId, "empty rollup", "purpose", "spec");
    createdDocIds.push(doc.id);
    await createAc({
      memexId: emptyMemexId, briefId: doc.id, kind: "implementation", statement: "no history",
    });

    const days = await listAcAlignmentOverTime(emptyMemexId, doc.id, 7);
    expect(days.length).toBeGreaterThan(0);
    expect(days.every((d) => d.measured === false)).toBe(true);
  });
});
