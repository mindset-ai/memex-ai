// Parity test: the per-Spec AC-health aggregator (board source) and
// `listAcsForBriefWithVerification` (AC tab source) MUST produce the same
// counts for the same Spec, derived through the same helpers (b-66 t-3,
// Scope AC-3).
//
// This is the test the scratchpad's Risks section explicitly called out:
// "A regression test that asserts board-state matches tab-state for the
// same Spec is worth writing."
//
// The test fails the moment anyone (a) changes `STALE_THRESHOLD_DAYS` in
// one code path and not the other, (b) reimplements `deriveVerificationState`
// in the aggregator instead of calling it, or (c) reconstructs canonical
// refs by hand instead of via `buildAcRef`. All three would silently break
// the board's visual contract with the AC tab.

import { describe, it, expect, afterAll, beforeAll } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { db } from "../db/connection.js";
import { documents, acs, testEvents, testEventLatest, memexes, namespaces } from "../db/schema.js";
import { createDocDraft } from "./documents.js";
import {
  createAc,
  aggregateAcHealthForBriefs,
  listAcsForBriefWithVerification,
  STALE_THRESHOLD_DAYS,
  type AcHealth,
  type VerificationState,
} from "./acs.js";
import { makeTestMemex, seedTestEvent } from "./test-helpers.js";
import { tagAc } from "@memex-ai-ac/vitest";

const B66 = "mindset-int/memex-app/specs/spec-66";
// spec-162 ac-2: this parity suite is the direct evidence that card colour and
// the AC tab derive from the same source and agree by construction. After the
// read swap to test_event_latest, both still consume the shared snapshot shape.
const SPEC162 = "mindset-prod/memex-building-itself/specs/spec-162";

const createdDocIds: string[] = [];
const createdAcUids: string[] = [];

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
    await db.delete(acs).where(eq(acs.briefId, id)).catch(() => {});
    await db.delete(documents).where(eq(documents.id, id)).catch(() => {});
  }
});

let memexId: string;
let namespaceSlug: string;
let memexSlug: string;

beforeAll(async () => {
  memexId = await makeTestMemex("par");
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

async function seedBrief() {
  const doc = await createDocDraft(memexId, "AC health parity", "purpose", "spec");
  createdDocIds.push(doc.id);
  return { id: doc.id, handle: doc.handle! };
}

function refOf(briefHandle: string, seq: number): string {
  return `${namespaceSlug}/${memexSlug}/specs/${briefHandle}/acs/ac-${seq}`;
}

async function emitEvent(
  acUid: string,
  status: "pass" | "fail" | "error",
  createdAt: Date = new Date(),
  testIdentifier = "tests/example.test.ts::it works",
): Promise<void> {
  createdAcUids.push(acUid);
  // spec-162: seed through the insert+summary-upsert path so both read paths
  // under parity (board aggregator + AC tab) see the event via test_event_latest.
  await seedTestEvent({ acUid, status, createdAt, testIdentifier });
}

/**
 * Reduce the AC-tab payload (`listAcsForBriefWithVerification`) into the same
 * six-number shape the board aggregator produces. If the two derivations are
 * truly identical, this reduction over the tab payload equals the aggregator
 * output byte-for-byte.
 */
function tallyTabPayload(
  states: VerificationState[],
  hadTests: boolean[],
): AcHealth {
  const tally: AcHealth = {
    totalActive: states.length,
    covered: 0,
    verified: 0,
    failing: 0,
    stale: 0,
    untested: 0,
  };
  for (let i = 0; i < states.length; i++) {
    if (hadTests[i]) tally.covered += 1;
    switch (states[i]) {
      case "verified":
        tally.verified += 1;
        break;
      case "failing":
        tally.failing += 1;
        break;
      case "stale":
        tally.stale += 1;
        break;
      case "untested":
        tally.untested += 1;
        break;
    }
  }
  return tally;
}

describe("aggregateAcHealthForBriefs parity with listAcsForBriefWithVerification", () => {
  it("produces the same six counts as the AC tab for a Spec with a representative AC mix", async () => {
    // b-66 ac-3: the strongest assertion. Seed a Spec with every state
    // (verified, failing, stale, untested) plus a non-active AC that both
    // paths should ignore. Aggregator output must equal the AC-tab payload
    // reduced through the same rules.
    tagAc(`${B66}/acs/ac-3`);
    tagAc(`${SPEC162}/acs/ac-2`);
    const spec = await seedBrief();

    const verifiedAc = await createAc({
      memexId, briefId: spec.id, kind: "scope", statement: "verified",
    });
    const failingAc = await createAc({
      memexId, briefId: spec.id, kind: "scope", statement: "failing",
    });
    const staleAc = await createAc({
      memexId, briefId: spec.id, kind: "implementation", statement: "stale",
    });
    await createAc({
      memexId, briefId: spec.id, kind: "scope", statement: "untested",
    });
    // Non-active AC — neither path should count it.
    await createAc({
      memexId, briefId: spec.id, kind: "scope", statement: "proposed",
      status: "proposed",
    });

    await emitEvent(refOf(spec.handle, verifiedAc.seq), "pass");
    await emitEvent(refOf(spec.handle, failingAc.seq), "fail");
    const longAgo = new Date(Date.now() - (STALE_THRESHOLD_DAYS + 2) * 86_400_000);
    await emitEvent(refOf(spec.handle, staleAc.seq), "pass", longAgo);

    const aggregator = await aggregateAcHealthForBriefs(memexId, [spec.id]);
    const tab = await listAcsForBriefWithVerification(memexId, spec.id);

    // The AC tab returns all ACs regardless of status — filter to active so
    // the tally matches what the aggregator counts. (Both paths exclude
    // non-active from the counted state; this is a function of how the tab
    // tab UI groups, not of the helper.)
    const activeRows = tab.filter((r) => r.ac.status === "active");
    const reduced = tallyTabPayload(
      activeRows.map((r) => r.verificationState),
      activeRows.map((r) => r.tests.length > 0),
    );

    const board = aggregator.get(spec.id);
    expect(board).toBeDefined();
    expect(board).toEqual(reduced);
    // Sanity: the mix exercised every counter.
    expect(board).toEqual({
      totalActive: 4,
      covered: 3,
      verified: 1,
      failing: 1,
      stale: 1,
      untested: 1,
    });
  });

  it("agrees with the AC tab on a Spec with no test events anywhere (all untested)", async () => {
    tagAc(`${B66}/acs/ac-3`);
    tagAc(`${SPEC162}/acs/ac-2`);
    const spec = await seedBrief();
    for (let i = 0; i < 3; i++) {
      await createAc({
        memexId, briefId: spec.id, kind: "scope", statement: `silent-no-emit ${i}`,
      });
    }

    const aggregator = await aggregateAcHealthForBriefs(memexId, [spec.id]);
    const tab = await listAcsForBriefWithVerification(memexId, spec.id);
    const reduced = tallyTabPayload(
      tab.map((r) => r.verificationState),
      tab.map((r) => r.tests.length > 0),
    );
    expect(aggregator.get(spec.id)).toEqual(reduced);
  });
});
