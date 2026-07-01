// Integration tests for the hard-delete orphan-retirement path
// (discontinueTestEventsForAc). DB-backed by necessity: the behaviour under
// test is the interplay of the append-only `test_events` log, the
// `test_event_latest` summary table (spec-162), and the verification verdict
// that reads the summary — none of which a pure unit test can exercise.
//
// spec-358 (dec-1) removed the soft-hide / restore mechanism (the last writer
// of `test_events.hidden`). Orphan retirement is now hard-delete only: it
// removes the dead identifier's emissions and clears their summary. The
// retirement is irreversible but still self-healing — a fresh live emission of
// the same identifier re-enters the verdict on its next run.
//
// Emissions route to the prod Memex (namespace-derived) and need MEMEX_EMIT_KEY
// in CI to land; locally they are inert (MEMEX_EMIT=false). The assertions are
// what verify the behaviour; the tags attribute that verification to the AC.

import { describe, it, expect, afterAll, beforeAll } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import { db } from "../db/connection.js";
import {
  documents,
  testEvents,
  testEventLatest,
  memexes,
  namespaces,
} from "../db/schema.js";
import { createDocDraft } from "./documents.js";
import {
  createAc,
  discontinueTestEventsForAc,
  listAcsForBriefWithVerification,
} from "./acs.js";
import { makeTestMemex, seedTestEvent } from "./test-helpers.js";
import { tagAc } from "@memex-ai-ac/vitest";

const SPEC = "mindset-prod/memex-building-itself/specs/spec-358";

const createdDocIds: string[] = [];
const createdAcUids: string[] = [];

let memexId: string;
let namespaceSlug: string;
let memexSlug: string;

beforeAll(async () => {
  memexId = await makeTestMemex("disc358");
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
      .where(inArray(testEvents.subjectRef, createdAcUids))
      .catch(() => {});
    await db
      .delete(testEventLatest)
      .where(inArray(testEventLatest.subjectRef, createdAcUids))
      .catch(() => {});
  }
  for (const id of createdDocIds) {
    await db.delete(documents).where(eq(documents.id, id)).catch(() => {});
  }
});

async function seedSpec(): Promise<{ id: string; handle: string }> {
  const doc = await createDocDraft(memexId, "discontinue test", "purpose", "spec");
  createdDocIds.push(doc.id);
  return { id: doc.id, handle: doc.handle! };
}

async function seedAc(statement: string): Promise<{ id: string; ref: string; briefId: string }> {
  const spec = await seedSpec();
  const ac = await createAc({ memexId, briefId: spec.id, kind: "scope", statement });
  const ref = `${namespaceSlug}/${memexSlug}/specs/${spec.handle}/acs/ac-${ac.seq}`;
  createdAcUids.push(ref);
  return { id: ac.id, ref, briefId: spec.id };
}

async function summaryRow(subjectRef: string, testIdentifier = "") {
  const [row] = await db
    .select()
    .from(testEventLatest)
    .where(
      and(
        eq(testEventLatest.subjectRef, subjectRef),
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

describe("discontinue_test_events hard delete (spec-358 dec-1)", () => {
  it("hard-deletes the orphan's emissions and clears the verdict, writing no hidden [ac-5][ac-7]", async () => {
    tagAc(`${SPEC}/acs/ac-5`);
    tagAc(`${SPEC}/acs/ac-7`);
    const ac = await seedAc("orphan to hard-delete");
    const tid = "tests/orphan.test.ts::renamed away";

    await seedTestEvent({ subjectRef: ac.ref, status: "fail", testIdentifier: tid });
    expect(await summaryRow(ac.ref, tid)).toBeDefined();
    expect(await stateOf(ac.briefId, ac.id)).toBe("failing");

    const result = await discontinueTestEventsForAc(memexId, ac.id, tid);
    expect(result.deleted).toBe(1);

    // Badge clears: the summary row is gone, so the verdict no longer sees it.
    expect(await summaryRow(ac.ref, tid)).toBeUndefined();
    expect(await stateOf(ac.briefId, ac.id)).toBe("untested");

    // Hard delete: the log rows are GONE (not flagged hidden). No row survives,
    // so nothing was written with hidden=true.
    const logRows = await db
      .select({ id: testEvents.id })
      .from(testEvents)
      .where(and(eq(testEvents.subjectRef, ac.ref), eq(testEvents.testIdentifier, tid)));
    expect(logRows).toHaveLength(0);
  });

  it("a fresh live emission after a discontinue re-enters the verdict (self-heal) [ac-5]", async () => {
    tagAc(`${SPEC}/acs/ac-5`);
    const ac = await seedAc("self-heal after hard-delete");
    const tid = "tests/heal.test.ts::it works";

    await seedTestEvent({ subjectRef: ac.ref, status: "fail", testIdentifier: tid });
    await discontinueTestEventsForAc(memexId, ac.id, tid);
    expect(await summaryRow(ac.ref, tid)).toBeUndefined();

    // The same identifier emits live again — re-surfaces and re-enters the verdict.
    await seedTestEvent({ subjectRef: ac.ref, status: "pass", testIdentifier: tid });
    expect(await summaryRow(ac.ref, tid)).toBeDefined();
    expect(await stateOf(ac.briefId, ac.id)).toBe("verified");
  });
});
