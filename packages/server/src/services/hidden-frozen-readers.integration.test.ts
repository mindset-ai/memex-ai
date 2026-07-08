// spec-358 — the `test_events.hidden` column is RETAINED and write-frozen
// (dec-2). Ingestion writes only counting rows (hidden=false); no code path
// writes hidden=true anymore. But every reader that excludes historical hidden
// rows is KEPT, so a pre-existing hidden=true row stays excluded from the
// verdict AND the per-AC matrix exactly as before — which is what keeps every
// existing board bit-for-bit identical (the governing constraint).
//
// DB-backed: the behaviour under test is the interplay of the append-only log,
// the summary table, and the verdict/matrix readers, none of which a unit test
// can exercise. We seed a hidden=true row DIRECTLY (simulating a frozen
// historical row — nothing in product code writes hidden=true any longer) and
// assert the readers still hide it.

import { describe, it, expect, afterAll, beforeAll } from "vitest";
import { eq, inArray, sql } from "drizzle-orm";
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
  listAcsForBriefWithVerification,
  listTestMatrixForAc,
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
  memexId = await makeTestMemex("frz358");
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
    await db.delete(testEvents).where(inArray(testEvents.subjectRef, createdAcUids)).catch(() => {});
    await db.delete(testEventLatest).where(inArray(testEventLatest.subjectRef, createdAcUids)).catch(() => {});
  }
  for (const id of createdDocIds) {
    await db.delete(documents).where(eq(documents.id, id)).catch(() => {});
  }
});

async function seedAc(statement: string): Promise<{ id: string; ref: string; briefId: string }> {
  const doc = await createDocDraft(memexId, "frozen-readers test", "purpose", "spec");
  createdDocIds.push(doc.id);
  const ac = await createAc({ memexId, briefId: doc.id, kind: "scope", statement });
  const ref = `${namespaceSlug}/${memexSlug}/specs/${doc.handle}/acs/ac-${ac.seq}`;
  createdAcUids.push(ref);
  return { id: ac.id, ref, briefId: doc.id };
}

async function stateOf(briefId: string, acId: string): Promise<string> {
  const rows = await listAcsForBriefWithVerification(memexId, briefId);
  const row = rows.find((r) => r.ac.id === acId);
  if (!row) throw new Error("ac not found in verification snapshot");
  return row.verificationState;
}

describe("spec-358: the hidden column is retained, write-frozen, and its readers still exclude historical rows", () => {
  it("a pre-existing hidden=true row is excluded from the verdict (reader kept) [ac-6][ac-10][ac-15]", async () => {
    tagAc(`${SPEC}/acs/ac-6`);
    tagAc(`${SPEC}/acs/ac-10`);
    tagAc(`${SPEC}/acs/ac-15`);
    const ac = await seedAc("frozen hidden row stays excluded");
    const tid = "tests/legacy.test.ts::was hidden";

    // A frozen historical hidden=true emission. applyEmissionToSummary skips
    // hidden, so no summary row lands and the verdict never sees it.
    await seedTestEvent({ subjectRef: ac.ref, status: "fail", testIdentifier: tid, hidden: true });
    expect(await stateOf(ac.briefId, ac.id)).toBe("untested");
  });

  it("a pre-existing hidden=true row is excluded from the per-AC matrix (reader kept) [ac-6][ac-10][ac-15]", async () => {
    tagAc(`${SPEC}/acs/ac-6`);
    tagAc(`${SPEC}/acs/ac-10`);
    tagAc(`${SPEC}/acs/ac-15`);
    const ac = await seedAc("frozen hidden row absent from matrix");
    const visibleTid = "tests/live.test.ts::counts";
    const hiddenTid = "tests/legacy.test.ts::hidden";

    await seedTestEvent({ subjectRef: ac.ref, status: "pass", testIdentifier: visibleTid });
    await seedTestEvent({ subjectRef: ac.ref, status: "fail", testIdentifier: hiddenTid, hidden: true });

    const matrix = await listTestMatrixForAc(memexId, ac.id);
    const ids = matrix.map((r) => r.testIdentifier);
    expect(ids).toContain(visibleTid);
    expect(ids).not.toContain(hiddenTid);
  });

  it("a counting row (hidden=false) counts toward the verdict — every real result counts [ac-9]", async () => {
    tagAc(`${SPEC}/acs/ac-9`);
    const ac = await seedAc("counting row counts");
    const tid = "tests/live.test.ts::passes";
    await seedTestEvent({ subjectRef: ac.ref, status: "pass", testIdentifier: tid });
    expect(await stateOf(ac.briefId, ac.id)).toBe("verified");
  });

  it("the test_events.hidden column still exists and is NOT renamed (no retired column) [ac-9][ac-12]", async () => {
    tagAc(`${SPEC}/acs/ac-9`);
    tagAc(`${SPEC}/acs/ac-12`);
    const cols = await db.execute(sql`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'test_events'
    `);
    const names = (cols as unknown as { rows?: Array<{ column_name: string }> }).rows
      ?? (cols as unknown as Array<{ column_name: string }>);
    const colNames = (names as Array<{ column_name: string }>).map((r) => r.column_name);
    expect(colNames).toContain("hidden");
    // dec-4: the column keeps the name `hidden` — no rename to `retired`.
    expect(colNames).not.toContain("retired");
  });
});
