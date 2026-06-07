// Integration tests for manual verification acceptance (spec-188 t-1).
//
// dec-1: 'accepted' is a first-class fifth verification state carried
// end-to-end on the AcWithVerification wire shape.
// dec-2: acceptance is an audited overlay (who/when) with evidence-wins
// precedence — failing test evidence suppresses it (never deletes it), and
// it is revocable via clearAcAcceptance.
//
// DB-backed for the same reason as acs-verification.integration.test.ts:
// the precedence rules live in deriveVerificationState but the production
// path runs them against the acs columns + test_event_latest join — a pure
// unit test on the helper could pass while the wiring is broken.

import { describe, it, expect, afterAll, beforeAll } from "vitest";
import { tagAc } from "@memex-ai-ac/vitest";
import { eq, inArray } from "drizzle-orm";
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
  setAcAcceptance,
  clearAcAcceptance,
  listAcsForBriefWithVerification,
  discontinueTestEventsForAc,
  aggregateAcHealthForBriefs,
} from "./acs.js";
import { ConflictError, ValidationError } from "../types/errors.js";
import { makeTestMemex, seedTestEvent } from "./test-helpers.js";

const SPEC188 = "mindset-prod/memex-building-itself/specs/spec-188";

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
  memexId = await makeTestMemex("acc");
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

async function seedBrief(): Promise<{ id: string; handle: string }> {
  const doc = await createDocDraft(memexId, "AC acceptance test", "purpose", "spec");
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
  await seedTestEvent({ acUid, status, createdAt, testIdentifier });
}

async function stateOf(briefId: string, acId: string) {
  const rows = await listAcsForBriefWithVerification(memexId, briefId);
  const found = rows.find((r) => r.ac.id === acId);
  expect(found).toBeDefined();
  return found!;
}

describe("manual verification acceptance (spec-188)", () => {
  it("carries 'accepted' as a fifth state end-to-end on the wire shape", async () => {
    // ac-6: AcVerificationState includes 'accepted' across the shared wire
    // shape — server derivation through AcWithVerification.
    tagAc(`${SPEC188}/acs/ac-6`);
    const spec = await seedBrief();
    const ac = await createAc({
      memexId,
      briefId: spec.id,
      kind: "scope",
      statement: "cannot be digitally tested",
    });

    await setAcAcceptance(memexId, ac.id, "Barrie Hadfield");

    const found = await stateOf(spec.id, ac.id);
    expect(found.verificationState).toBe("accepted");
    expect(found.ac.acceptedBy).toBe("Barrie Hadfield");
    expect(found.ac.acceptedAt).not.toBeNull();
  });

  it("records actor + timestamp as an audited acceptance", async () => {
    // ac-8: acceptance persists an audited record (actor + timestamp).
    tagAc(`${SPEC188}/acs/ac-8`);
    const spec = await seedBrief();
    const ac = await createAc({
      memexId,
      briefId: spec.id,
      kind: "implementation",
      statement: "audited acceptance",
    });

    const before = Date.now();
    await setAcAcceptance(memexId, ac.id, "reviewer@example.com");
    const [row] = await db.select().from(acs).where(eq(acs.id, ac.id));
    expect(row.acceptedBy).toBe("reviewer@example.com");
    expect(row.acceptedAt).not.toBeNull();
    expect(row.acceptedAt!.getTime()).toBeGreaterThanOrEqual(before - 1000);
    expect(row.acceptedAt!.getTime()).toBeLessThanOrEqual(Date.now() + 1000);
  });

  it("rejects a blank actor", async () => {
    tagAc(`${SPEC188}/acs/ac-8`);
    const spec = await seedBrief();
    const ac = await createAc({
      memexId,
      briefId: spec.id,
      kind: "scope",
      statement: "blank actor",
    });
    await expect(setAcAcceptance(memexId, ac.id, "   ")).rejects.toThrow(
      ValidationError,
    );
  });

  it("suppresses acceptance while failing evidence exists, and returns when it clears", async () => {
    // ac-9: evidence-wins precedence — accepted → failing on a fail event
    // (acceptance NOT deleted) → accepted again once the evidence clears.
    tagAc(`${SPEC188}/acs/ac-9`);
    const spec = await seedBrief();
    const ac = await createAc({
      memexId,
      briefId: spec.id,
      kind: "implementation",
      statement: "evidence wins",
    });
    const ref = refOf(spec.handle, ac.seq);

    await setAcAcceptance(memexId, ac.id, "Barrie");
    expect((await stateOf(spec.id, ac.id)).verificationState).toBe("accepted");

    // Failing evidence appears → state drops to failing; the acceptance
    // columns survive untouched (suppressed, not deleted).
    await emitEvent(ref, "fail");
    const failing = await stateOf(spec.id, ac.id);
    expect(failing.verificationState).toBe("failing");
    expect(failing.ac.acceptedBy).toBe("Barrie");
    expect(failing.ac.acceptedAt).not.toBeNull();

    // The same test passes again → evidence cleared → back to accepted
    // (NOT verified: per dec-2 the acceptance presents when no failing
    // evidence exists), with no re-accept needed.
    await emitEvent(ref, "pass");
    expect((await stateOf(spec.id, ac.id)).verificationState).toBe("accepted");
  });

  it("returns to accepted when failing evidence is discontinued", async () => {
    tagAc(`${SPEC188}/acs/ac-9`);
    const spec = await seedBrief();
    const ac = await createAc({
      memexId,
      briefId: spec.id,
      kind: "implementation",
      statement: "discontinue clears evidence",
    });
    const ref = refOf(spec.handle, ac.seq);
    const testIdentifier = "tests/old.test.ts::renamed away";

    await setAcAcceptance(memexId, ac.id, "Barrie");
    await emitEvent(ref, "fail", new Date(), testIdentifier);
    expect((await stateOf(spec.id, ac.id)).verificationState).toBe("failing");

    await discontinueTestEventsForAc(memexId, ac.id, testIdentifier);
    expect((await stateOf(spec.id, ac.id)).verificationState).toBe("accepted");
  });

  it("error status suppresses acceptance the same as fail", async () => {
    tagAc(`${SPEC188}/acs/ac-9`);
    const spec = await seedBrief();
    const ac = await createAc({
      memexId,
      briefId: spec.id,
      kind: "implementation",
      statement: "error counts as contradicting evidence",
    });
    const ref = refOf(spec.handle, ac.seq);

    await setAcAcceptance(memexId, ac.id, "Barrie");
    await emitEvent(ref, "error");
    expect((await stateOf(spec.id, ac.id)).verificationState).toBe("failing");
  });

  it("un-accept revokes and restores the test-derived state", async () => {
    // ac-9 (revocation half of dec-2; the row affordance is t-2/ac-10).
    tagAc(`${SPEC188}/acs/ac-9`);
    const spec = await seedBrief();

    // Untested AC: accepted → un-accept → back to untested.
    const untested = await createAc({
      memexId,
      briefId: spec.id,
      kind: "scope",
      statement: "untested after revoke",
    });
    await setAcAcceptance(memexId, untested.id, "Barrie");
    expect((await stateOf(spec.id, untested.id)).verificationState).toBe(
      "accepted",
    );
    await clearAcAcceptance(memexId, untested.id);
    const reverted = await stateOf(spec.id, untested.id);
    expect(reverted.verificationState).toBe("untested");
    expect(reverted.ac.acceptedBy).toBeNull();
    expect(reverted.ac.acceptedAt).toBeNull();

    // Passing AC: accepted presents over verified; un-accept → verified.
    const passing = await createAc({
      memexId,
      briefId: spec.id,
      kind: "implementation",
      statement: "verified after revoke",
    });
    const ref = refOf(spec.handle, passing.seq);
    await emitEvent(ref, "pass");
    await setAcAcceptance(memexId, passing.id, "Barrie");
    expect((await stateOf(spec.id, passing.id)).verificationState).toBe(
      "accepted",
    );
    await clearAcAcceptance(memexId, passing.id);
    expect((await stateOf(spec.id, passing.id)).verificationState).toBe(
      "verified",
    );
  });

  it("un-accept with no acceptance is a conflict", async () => {
    tagAc(`${SPEC188}/acs/ac-9`);
    const spec = await seedBrief();
    const ac = await createAc({
      memexId,
      briefId: spec.id,
      kind: "scope",
      statement: "nothing to revoke",
    });
    await expect(clearAcAcceptance(memexId, ac.id)).rejects.toThrow(
      ConflictError,
    );
  });

  it("board health aggregator tallies accepted with tab parity", async () => {
    // ac-6: the fifth state flows through aggregateAcHealthForBriefs too —
    // board card and AC tab cannot disagree.
    tagAc(`${SPEC188}/acs/ac-6`);
    const spec = await seedBrief();
    const acceptedAc = await createAc({
      memexId,
      briefId: spec.id,
      kind: "scope",
      statement: "accepted, no tests",
    });
    const verifiedAc = await createAc({
      memexId,
      briefId: spec.id,
      kind: "implementation",
      statement: "plain verified",
    });
    await setAcAcceptance(memexId, acceptedAc.id, "Barrie");
    await emitEvent(refOf(spec.handle, verifiedAc.seq), "pass");

    const health = (await aggregateAcHealthForBriefs(memexId, [spec.id])).get(
      spec.id,
    )!;
    expect(health.totalActive).toBe(2);
    expect(health.accepted).toBe(1);
    expect(health.verified).toBe(1);
    expect(health.untested).toBe(0);

    const tab = await listAcsForBriefWithVerification(memexId, spec.id);
    const tabAccepted = tab.filter(
      (r) => r.verificationState === "accepted",
    ).length;
    expect(tabAccepted).toBe(health.accepted);
  });
});
