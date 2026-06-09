// Integration tests for the soft-hide / restore discontinue path (spec-127
// dec-1). DB-backed by necessity: the behaviour under test is the interplay of
// the append-only `test_events` log, the `test_event_latest` summary table
// (spec-162), and the verification verdict that reads the summary — none of
// which a pure unit test can exercise.
//
// The orphan self-heal story in code:
//   - soft-hide sets hidden=true on the log rows (audit kept) AND evicts the
//     summary row, so the badge clears even though the verdict reads the
//     summary, not the filtered log;
//   - restore unhides AND recomputes the summary from the surviving non-hidden
//     rows;
//   - a fresh non-hidden emission re-enters the verdict regardless (self-heal).
//
// Emissions route to the prod Memex (namespace-derived) and need MEMEX_EMIT_KEY
// in CI to land; locally they are inert (MEMEX_EMIT=false). The assertions are
// what verify the behaviour; the tags attribute that verification to the AC.

import { describe, it, expect, afterAll, beforeAll } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import { db } from "../db/connection.js";
import {
  documents,
  acs,
  testEvents,
  testEventLatest,
  memexes,
  namespaces,
} from "../db/schema.js";
import { createDocDraft } from "./documents.js";
import {
  createAc,
  softHideTestEventsForAc,
  restoreTestEventsForAc,
  listAcsForBriefWithVerification,
} from "./acs.js";
import { recomputeSummaryForPair } from "./test-event-latest.js";
import { makeTestMemex, seedTestEvent } from "./test-helpers.js";
import { tagAc } from "@memex-ai-ac/vitest";

const SPEC = "mindset-prod/memex-building-itself/specs/spec-127";

const createdDocIds: string[] = [];
const createdAcUids: string[] = [];

let memexId: string;
let namespaceSlug: string;
let memexSlug: string;

beforeAll(async () => {
  memexId = await makeTestMemex("sh127");
  const [row] = await db
    .select({ memexSlug: memexes.slug, namespaceSlug: namespaces.slug })
    .from(memexes)
    .innerJoin(namespaces, eq(memexes.namespaceId, namespaces.id))
    .where(eq(memexes.id, memexId))
    .limit(1);
  if (!row) throw new Error("could not resolve test memex slugs");
  memexSlug = row.memexSlug;
  namespaceSlug = row.namespaceSlug;
});

afterAll(async () => {
  if (createdAcUids.length) {
    await db
      .delete(testEvents)
      .where(inArray(testEvents.acUid, createdAcUids))
      .catch(() => {});
    await db
      .delete(testEventLatest)
      .where(inArray(testEventLatest.acUid, createdAcUids))
      .catch(() => {});
  }
  for (const id of createdDocIds) {
    await db.delete(documents).where(eq(documents.id, id)).catch(() => {});
  }
});

async function seedSpec(): Promise<{ id: string; handle: string }> {
  const doc = await createDocDraft(memexId, "soft-hide test", "purpose", "spec");
  createdDocIds.push(doc.id);
  return { id: doc.id, handle: doc.handle! };
}

async function seedAc(): Promise<{ id: string; ref: string }> {
  const spec = await seedSpec();
  const ac = await createAc({
    memexId,
    briefId: spec.id,
    kind: "scope",
    statement: "orphan retirement target",
  });
  const ref = `${namespaceSlug}/${memexSlug}/specs/${spec.handle}/acs/ac-${ac.seq}`;
  createdAcUids.push(ref);
  return { id: ac.id, ref };
}

async function summaryRow(acUid: string, testIdentifier = "") {
  const [row] = await db
    .select()
    .from(testEventLatest)
    .where(
      and(
        eq(testEventLatest.acUid, acUid),
        eq(testEventLatest.testIdentifier, testIdentifier),
      ),
    );
  return row;
}

async function stateOf(briefId: string, acId: string): Promise<string> {
  const rows = await listAcsForBriefWithVerification(memexId, briefId);
  const row = rows.find((r) => r.ac.id === acId);
  if (!row) throw new Error("ac not found in verification snapshot");
  return row.verificationState;
}

describe("soft-hide / restore discontinue (spec-127)", () => {
  it("soft-hide clears the verdict but keeps the log rows for audit [ac-7][ac-3][ac-1][ac-2]", async () => {
    tagAc(`${SPEC}/acs/ac-7`);
    tagAc(`${SPEC}/acs/ac-3`);
    // ac-1: an orphaned (failing) test_identifier no longer pins the AC red once
    // retired. ac-2: retirement is an explicit, actor-driven call — there is no
    // automatic run-correlation job; this test IS the explicit retirement.
    tagAc(`${SPEC}/acs/ac-1`);
    tagAc(`${SPEC}/acs/ac-2`);
    const spec = await seedSpec();
    const ac = await createAc({
      memexId,
      briefId: spec.id,
      kind: "scope",
      statement: "soft-hide me",
    });
    const ref = `${namespaceSlug}/${memexSlug}/specs/${spec.handle}/acs/ac-${ac.seq}`;
    createdAcUids.push(ref);
    const tid = "tests/orphan.test.ts::renamed away";

    await seedTestEvent({ acUid: ref, status: "fail", testIdentifier: tid });
    expect(await summaryRow(ref, tid)).toBeDefined();
    expect(await stateOf(spec.id, ac.id)).toBe("failing");

    const result = await softHideTestEventsForAc(memexId, ac.id, tid);
    expect(result.hidden).toBe(1);

    // Badge clears: the summary row is evicted, so the verdict no longer sees it.
    expect(await summaryRow(ref, tid)).toBeUndefined();
    expect(await stateOf(spec.id, ac.id)).toBe("untested");

    // Audit intact: the log row survives, flagged hidden=true (not deleted).
    const logRows = await db
      .select({ hidden: testEvents.hidden, status: testEvents.status })
      .from(testEvents)
      .where(and(eq(testEvents.acUid, ref), eq(testEvents.testIdentifier, tid)));
    expect(logRows).toHaveLength(1);
    expect(logRows[0]?.hidden).toBe(true);
    expect(logRows[0]?.status).toBe("fail");
  });

  it("a fresh non-hidden emission after a soft-hide re-enters the verdict (self-heal) [ac-3][ac-1]", async () => {
    tagAc(`${SPEC}/acs/ac-3`);
    // ac-1: "once the live tests for that AC are green" — a fresh live emission
    // re-enters the verdict, the self-healing half of the orphan story.
    tagAc(`${SPEC}/acs/ac-1`);
    const spec = await seedSpec();
    const ac = await createAc({
      memexId,
      briefId: spec.id,
      kind: "scope",
      statement: "self-heal me",
    });
    const ref = `${namespaceSlug}/${memexSlug}/specs/${spec.handle}/acs/ac-${ac.seq}`;
    createdAcUids.push(ref);
    const tid = "tests/heal.test.ts::it works";

    await seedTestEvent({ acUid: ref, status: "fail", testIdentifier: tid });
    await softHideTestEventsForAc(memexId, ac.id, tid);
    expect(await summaryRow(ref, tid)).toBeUndefined();

    // The same identifier emits live again — lands hidden=false and re-surfaces.
    await seedTestEvent({ acUid: ref, status: "pass", testIdentifier: tid });
    expect(await summaryRow(ref, tid)).toBeDefined();
    expect(await stateOf(spec.id, ac.id)).toBe("verified");
  });

  it("restore recomputes the summary from surviving non-hidden rows, newest-wins [ac-7][ac-3]", async () => {
    tagAc(`${SPEC}/acs/ac-7`);
    tagAc(`${SPEC}/acs/ac-3`);
    const spec = await seedSpec();
    const ac = await createAc({
      memexId,
      briefId: spec.id,
      kind: "scope",
      statement: "restore me",
    });
    const ref = `${namespaceSlug}/${memexSlug}/specs/${spec.handle}/acs/ac-${ac.seq}`;
    createdAcUids.push(ref);
    const tid = "tests/restore.test.ts::it works";

    // An older pass then a newer fail — verdict is failing.
    await seedTestEvent({
      acUid: ref,
      status: "pass",
      testIdentifier: tid,
      createdAt: new Date(Date.now() - 60_000),
    });
    await seedTestEvent({
      acUid: ref,
      status: "fail",
      testIdentifier: tid,
      createdAt: new Date(Date.now() - 1_000),
    });
    expect(await stateOf(spec.id, ac.id)).toBe("failing");

    await softHideTestEventsForAc(memexId, ac.id, tid);
    expect(await summaryRow(ref, tid)).toBeUndefined();

    const result = await restoreTestEventsForAc(memexId, ac.id, tid);
    expect(result.restored).toBe(2);

    // Recompute brings the pair back at the NEWEST surviving status (fail),
    // with run_count = the two non-hidden rows.
    const row = await summaryRow(ref, tid);
    expect(row?.latestStatus).toBe("fail");
    expect(row?.runCount).toBe(2);
    expect(await stateOf(spec.id, ac.id)).toBe("failing");
  });

  it("recompute drops a stale summary row when no non-hidden rows survive [ac-7]", async () => {
    tagAc(`${SPEC}/acs/ac-7`);
    const { ref } = await seedAc();
    const tid = "tests/all-gone.test.ts::it works";

    // Seed a visible event so the summary row exists, then mark the log row
    // hidden directly (bypassing summary maintenance) to simulate a state where
    // the summary is stale relative to the log. Recompute must delete it.
    await seedTestEvent({ acUid: ref, status: "fail", testIdentifier: tid });
    expect(await summaryRow(ref, tid)).toBeDefined();

    await db
      .update(testEvents)
      .set({ hidden: true })
      .where(and(eq(testEvents.acUid, ref), eq(testEvents.testIdentifier, tid)));

    await recomputeSummaryForPair(db, ref, tid);
    expect(await summaryRow(ref, tid)).toBeUndefined();
  });
});
