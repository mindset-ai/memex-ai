// spec-520 t-11 — the two consumers that could be re-based cleanly.
//
// ac-24 (testRunVolume) and ac-25 (verifyingAcIsGreen). The other two named by t-11 are
// NOT here and not attempted:
//   • auditCiEmissionForBrief needs run_id + metadata, which test_event_latest does not
//     carry — dec-8.
//   • listAcAlignmentOverTime's first-verified half reads ac_first_verified, which dec-7
//     deliberately left in place.
//
// THE PROOF SHAPE ac-24 ASKS FOR is "results no longer change when raw events age out".
// So these tests seed the DERIVED tier and leave the raw log EMPTY. Under the old
// implementation that is indistinguishable from "nothing ever happened" — which is exactly
// the defect: the charts read a log that retention had already emptied. Seeding the raw log
// too would let a still-broken implementation pass.

import { describe, it, expect, afterAll, beforeAll } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { tagAc } from "@memex-ai-ac/vitest";
import { db, runWithMemexId } from "../db/connection.js";
import {
  acs,
  documents,
  issues,
  memexes,
  namespaces,
  taskSatisfiesAc,
  tasks,
  testEventLatest,
  testEvents,
  testRunDaily,
} from "../db/schema.js";
import { testRunVolume } from "./analytics.js";
import { createDocDraft } from "./documents.js";
import { maybeAutoResolveIssuesForTask } from "./issues.js";
import { makeTestMemex } from "./test-helpers.js";
import { upsertUserByEmail } from "./users.js";

// NARROWED to ac-35 / ac-36 rather than ac-24 / ac-25 (2026-08-28). Each of those states
// TWO consumers and only one of each pair could be moved — listAcAlignmentOverTime is
// blocked on dec-7, auditCiEmissionForBrief on dec-8. Tagging the two-consumer criteria
// from half the work would flip them green on a weaker property than they state, which is
// exactly why ac-22 and ac-32 were split. It briefly happened here before these existed;
// the stale emissions on ac-24/ac-25 were retired with discontinue_test_events.
const AC_CHARTS = "mindset-prod/memex-building-itself/specs/spec-520/acs/ac-35";
const AC_LATEST = "mindset-prod/memex-building-itself/specs/spec-520/acs/ac-36";

let memexId: string;
let userId: string;
let namespaceSlug: string;
let memexSlug: string;
const createdDocIds: string[] = [];
const createdRefs: string[] = [];

beforeAll(async () => {
  memexId = await makeTestMemex("t11");
  const user = await upsertUserByEmail(`spec520-t11-${process.pid}@example.com`);
  userId = user.id;
  const [row] = await db
    .select({ m: memexes.slug, n: namespaces.slug })
    .from(memexes)
    .innerJoin(namespaces, eq(memexes.namespaceId, namespaces.id))
    .where(eq(memexes.id, memexId))
    .limit(1);
  memexSlug = row!.m;
  namespaceSlug = row!.n;
});

afterAll(async () => {
  await db.delete(testRunDaily).where(eq(testRunDaily.memexId, memexId)).catch(() => {});
  if (createdRefs.length) {
    await db.delete(testEventLatest).where(inArray(testEventLatest.subjectRef, createdRefs)).catch(() => {});
    await db.delete(testEvents).where(inArray(testEvents.subjectRef, createdRefs)).catch(() => {});
  }
  if (createdDocIds.length) {
    await db.delete(documents).where(inArray(documents.id, createdDocIds)).catch(() => {});
  }
});

describe("spec-520 ac-24: testRunVolume reads the rollup, not the raw log", () => {
  it("reports the counts the rollup holds even with NO raw events at all", async () => {
    tagAc(AC_CHARTS);

    const ref = `${namespaceSlug}/${memexSlug}/specs/spec-1/acs/ac-1`;
    createdRefs.push(ref);

    // The rollup is the durable tier. The raw log is left EMPTY on purpose — that is the
    // aged-out state the charts have been misreading as "no activity".
    await db.insert(testRunDaily).values([
      { memexId, subjectRef: ref, testIdentifier: "a::t", day: "2026-08-20", runCount: 5, passCount: 4, failCount: 1, errorCount: 0 },
      { memexId, subjectRef: ref, testIdentifier: "b::t", day: "2026-08-20", runCount: 3, passCount: 3, failCount: 0, errorCount: 0 },
      { memexId, subjectRef: ref, testIdentifier: "a::t", day: "2026-08-21", runCount: 2, passCount: 1, failCount: 0, errorCount: 1 },
    ] as (typeof testRunDaily.$inferInsert)[]);

    const points = await testRunVolume(memexId);
    const byDay = new Map(points.map((p) => [p.day, p]));

    // Summed ACROSS test_identifiers, which is what a per-day volume chart means.
    expect(byDay.get("2026-08-20")).toMatchObject({ pass: 7, fail: 1, error: 0 });
    expect(byDay.get("2026-08-21")).toMatchObject({ pass: 1, fail: 0, error: 1 });
  });

  it("is scoped by memex_id, not by a subject_ref string prefix", async () => {
    tagAc(AC_CHARTS);

    // The old read matched `subject_ref LIKE 'ns/mx/%'` — tenancy carried by a string,
    // which is the spec-396 leak pattern this Spec closes elsewhere. A row belonging to
    // another tenant must not appear however its ref happens to read.
    const otherMemexId = await makeTestMemex("t11b");
    const foreignRef = `${namespaceSlug}/${memexSlug}/specs/spec-9/acs/ac-9`;
    createdRefs.push(foreignRef);
    await db.insert(testRunDaily).values({
      memexId: otherMemexId,
      subjectRef: foreignRef,
      testIdentifier: "x::t",
      day: "2026-08-20",
      runCount: 99,
      passCount: 99,
      failCount: 0,
      errorCount: 0,
    } as typeof testRunDaily.$inferInsert);

    const points = await testRunVolume(memexId);
    const day = points.find((p) => p.day === "2026-08-20");
    // 7, not 106 — the foreign row carries this memex's ref prefix but another memex_id.
    expect(day?.pass).toBe(7);

    await db.delete(testRunDaily).where(eq(testRunDaily.memexId, otherMemexId)).catch(() => {});
  });
});

describe("spec-520 ac-25: the auto-resolve gate reads test_event_latest, not the raw log", () => {
  it("resolves a converted Issue from the SUMMARY alone, with the raw log empty", async () => {
    tagAc(AC_LATEST);

    const built = await runWithMemexId(memexId, async () => {
      const doc = await createDocDraft(memexId, `t11 gate ${process.pid}`, "", "spec");
      createdDocIds.push(doc.id);

      const [ac] = await db
        .insert(acs)
        .values({ memexId, briefId: doc.id, seq: 1, kind: "implementation", statement: "verifies", status: "active" } as typeof acs.$inferInsert)
        .returning();
      const [task] = await db
        .insert(tasks)
        .values({ memexId, docId: doc.id, seq: 1, title: "satisfying", description: "", status: "complete" } as typeof tasks.$inferInsert)
        .returning();
      await db.insert(taskSatisfiesAc).values({ taskId: task!.id, acId: ac!.id } as typeof taskSatisfiesAc.$inferInsert);
      const [issue] = await db
        .insert(issues)
        .values({ memexId, docId: doc.id, seq: 1, title: "awaiting green", body: "", type: "bug", severity: "high", status: "converted", source: "agent", satisfyingTaskId: task!.id, createdByUserId: userId } as typeof issues.$inferInsert)
        .returning();
      return { handle: doc.handle, taskId: task!.id, issueId: issue!.id };
    });

    const ref = `${namespaceSlug}/${memexSlug}/specs/${built.handle}/acs/ac-1`;
    createdRefs.push(ref);

    // ONLY the summary. No raw test_events row exists — the state after retention has aged
    // the passing event out. The old implementation scans test_events, finds nothing, and
    // refuses to resolve; that is the red.
    await runWithMemexId(memexId, async () => {
      await db.insert(testEventLatest).values({
        subjectRef: ref,
        memexId,
        testIdentifier: "suite::verifies",
        latestStatus: "pass",
        latestRunAt: new Date("2026-08-20T10:00:00.000Z"),
        runCount: 1,
      } as typeof testEventLatest.$inferInsert);
    });

    const resolved = await runWithMemexId(memexId, async () =>
      maybeAutoResolveIssuesForTask(memexId, built.taskId),
    );
    expect(resolved).toContain(built.issueId);
  });

  it("still refuses when the summary's latest is a FAIL", async () => {
    tagAc(AC_LATEST);

    const built = await runWithMemexId(memexId, async () => {
      const doc = await createDocDraft(memexId, `t11 gate red ${process.pid}`, "", "spec");
      createdDocIds.push(doc.id);
      const [ac] = await db
        .insert(acs)
        .values({ memexId, briefId: doc.id, seq: 1, kind: "implementation", statement: "verifies", status: "active" } as typeof acs.$inferInsert)
        .returning();
      const [task] = await db
        .insert(tasks)
        .values({ memexId, docId: doc.id, seq: 1, title: "satisfying", description: "", status: "complete" } as typeof tasks.$inferInsert)
        .returning();
      await db.insert(taskSatisfiesAc).values({ taskId: task!.id, acId: ac!.id } as typeof taskSatisfiesAc.$inferInsert);
      const [issue] = await db
        .insert(issues)
        .values({ memexId, docId: doc.id, seq: 1, title: "awaiting green", body: "", type: "bug", severity: "high", status: "converted", source: "agent", satisfyingTaskId: task!.id, createdByUserId: userId } as typeof issues.$inferInsert)
        .returning();
      return { handle: doc.handle, taskId: task!.id, issueId: issue!.id };
    });

    const ref = `${namespaceSlug}/${memexSlug}/specs/${built.handle}/acs/ac-1`;
    createdRefs.push(ref);

    await runWithMemexId(memexId, async () => {
      await db.insert(testEventLatest).values({
        subjectRef: ref,
        memexId,
        testIdentifier: "suite::verifies",
        latestStatus: "fail",
        latestRunAt: new Date("2026-08-20T10:00:00.000Z"),
        runCount: 1,
      } as typeof testEventLatest.$inferInsert);
    });

    // Re-basing must not weaken the gate into "a row exists" — the STATUS still decides.
    const resolved = await runWithMemexId(memexId, async () =>
      maybeAutoResolveIssuesForTask(memexId, built.taskId),
    );
    expect(resolved).toEqual([]);
  });
});
