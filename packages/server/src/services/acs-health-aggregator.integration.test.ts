// Integration tests for the per-Spec AC-health aggregator (b-66 t-2).
//
// DB-backed by design — the aggregator's correctness depends on the
// canonical-ref join string assembled across four tables (namespaces +
// memexes + documents + acs) matching the ac_uid the tagAc helper emits.
// A unit test on the pure tally function would pass while the join silently
// breaks; only an integration test catches that.
//
// Companion to acs-verification.integration.test.ts — these tests share the
// same seeding pattern; the parity assertion between this aggregator and
// `listAcsForBriefWithVerification` lives in t-3.

import { describe, it, expect, afterAll, beforeAll } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { db } from "../db/connection.js";
import { documents, acs, testEvents, memexes, namespaces } from "../db/schema.js";
import { createDocDraft } from "./documents.js";
import { createAc, aggregateAcHealthForBriefs, STALE_THRESHOLD_DAYS } from "./acs.js";
import { makeTestMemex, seedTestEvent } from "./test-helpers.js";
import { testEventLatest } from "../db/schema.js";
import { tagAc } from "@memex-ai-ac/vitest";

const B66 = "mindset-int/memex-app/specs/spec-66";

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
  memexId = await makeTestMemex("ach");
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
  const doc = await createDocDraft(memexId, "AC health test", "purpose", "spec");
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
  // spec-162: seed through the same insert+summary-upsert path the route uses,
  // so the read-under-test (which now reads test_event_latest) sees the event.
  await seedTestEvent({ acUid, status, createdAt, testIdentifier });
}

describe("aggregateAcHealthForBriefs", () => {
  it("returns an empty map when given no briefIds", async () => {
    const out = await aggregateAcHealthForBriefs(memexId, []);
    expect(out.size).toBe(0);
  });

  it("seeds a zero-AC Spec with totalActive=0 (caller decides whether to attach)", async () => {
    // b-66 ac-4: a Spec with zero active ACs renders as today — no border,
    // no chip, no strip. The aggregator's contract is to make this case
    // legible without confusing it with "Spec was not aggregated at all".
    tagAc(`${B66}/acs/ac-4`);
    const spec = await seedBrief();
    const out = await aggregateAcHealthForBriefs(memexId, [spec.id]);
    expect(out.get(spec.id)).toEqual({
      totalActive: 0,
      covered: 0,
      verified: 0,
      failing: 0,
      stale: 0,
      accepted: 0,
      untested: 0,
    });
  });

  it("derives state via the shared deriveVerificationState helper (verified path)", async () => {
    // b-66 ac-3: the aggregator must call the same helper the AC tab uses;
    // proven empirically by checking a verified AC lands in `verified` and
    // not in `untested`.
    tagAc(`${B66}/acs/ac-3`);
    const spec = await seedBrief();
    const ac = await createAc({
      memexId,
      briefId: spec.id,
      kind: "scope",
      statement: "verified ac",
    });
    await emitEvent(refOf(spec.handle, ac.seq), "pass");

    const out = await aggregateAcHealthForBriefs(memexId, [spec.id]);
    expect(out.get(spec.id)).toEqual({
      totalActive: 1,
      covered: 1,
      verified: 1,
      failing: 0,
      stale: 0,
      accepted: 0,
      untested: 0,
    });
  });

  it("counts a failing AC as failing (not verified, not untested)", async () => {
    tagAc(`${B66}/acs/ac-3`);
    const spec = await seedBrief();
    const passing = await createAc({
      memexId,
      briefId: spec.id,
      kind: "scope",
      statement: "p",
    });
    const failing = await createAc({
      memexId,
      briefId: spec.id,
      kind: "scope",
      statement: "f",
    });
    await emitEvent(refOf(spec.handle, passing.seq), "pass");
    await emitEvent(refOf(spec.handle, failing.seq), "fail");

    const out = await aggregateAcHealthForBriefs(memexId, [spec.id]);
    expect(out.get(spec.id)).toEqual({
      totalActive: 2,
      covered: 2,
      verified: 1,
      failing: 1,
      stale: 0,
      accepted: 0,
      untested: 0,
    });
  });

  it("counts a stale AC as stale (verified-but-old-than-threshold)", async () => {
    tagAc(`${B66}/acs/ac-3`);
    const spec = await seedBrief();
    const ac = await createAc({
      memexId,
      briefId: spec.id,
      kind: "scope",
      statement: "stale",
    });
    // Last run is past the stale threshold — deriveVerificationState
    // returns 'stale', not 'verified'.
    const longAgo = new Date(Date.now() - (STALE_THRESHOLD_DAYS + 2) * 86_400_000);
    await emitEvent(refOf(spec.handle, ac.seq), "pass", longAgo);

    const out = await aggregateAcHealthForBriefs(memexId, [spec.id]);
    expect(out.get(spec.id)).toEqual({
      totalActive: 1,
      covered: 1,
      verified: 0,
      failing: 0,
      stale: 1,
      accepted: 0,
      untested: 0,
    });
  });

  it("counts a zero-event AC as untested (covered=0; silent-no-emit case)", async () => {
    tagAc(`${B66}/acs/ac-3`);
    const spec = await seedBrief();
    await createAc({
      memexId,
      briefId: spec.id,
      kind: "scope",
      statement: "no tests yet",
    });

    const out = await aggregateAcHealthForBriefs(memexId, [spec.id]);
    expect(out.get(spec.id)).toEqual({
      totalActive: 1,
      covered: 0,
      verified: 0,
      failing: 0,
      stale: 0,
      accepted: 0,
      untested: 1,
    });
  });

  it("excludes non-active ACs (proposed/rejected/superseded) from the counts", async () => {
    // Active is the only status the manager has committed to. Anything
    // else is a commitment in limbo and shouldn't inflate the totals.
    tagAc(`${B66}/acs/ac-3`);
    const spec = await seedBrief();
    await createAc({
      memexId,
      briefId: spec.id,
      kind: "scope",
      statement: "active",
      status: "active",
    });
    await createAc({
      memexId,
      briefId: spec.id,
      kind: "scope",
      statement: "proposed",
      status: "proposed",
    });

    const out = await aggregateAcHealthForBriefs(memexId, [spec.id]);
    const h = out.get(spec.id);
    expect(h?.totalActive).toBe(1);
  });

  it("tallies ACs to the correct Spec when multiple Specs are aggregated together", async () => {
    // Cross-tenancy isn't the worry here (specs share a memex) — the worry
    // is the in-memory bucketing. Easy to write a helper that puts every
    // AC under the first Spec id; this test catches that.
    tagAc(`${B66}/acs/ac-3`);
    const a = await seedBrief();
    const b = await seedBrief();
    const acA = await createAc({
      memexId,
      briefId: a.id,
      kind: "scope",
      statement: "for A",
    });
    const acB = await createAc({
      memexId,
      briefId: b.id,
      kind: "scope",
      statement: "for B",
    });
    await emitEvent(refOf(a.handle, acA.seq), "pass");
    await emitEvent(refOf(b.handle, acB.seq), "fail");

    const out = await aggregateAcHealthForBriefs(memexId, [a.id, b.id]);
    expect(out.get(a.id)).toMatchObject({ totalActive: 1, verified: 1, failing: 0 });
    expect(out.get(b.id)).toMatchObject({ totalActive: 1, verified: 0, failing: 1 });
  });
});
