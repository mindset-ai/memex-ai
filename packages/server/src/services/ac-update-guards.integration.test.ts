// spec-566 t-3 — the two `update_ac` guards (dec-8 and dec-9).
//
// dec-7's done-gate protects nothing while `update_ac` remains a free call on a
// criterion that has already gone green: the cheapest way to clear the gate would
// be to edit the criterion until it is true, which is the exact move this Spec
// exists to price. These two refusals are that enforcement point.
//
//   ac-23  a criterion that currently reads as satisfied is not editable here
//   ac-26  a criterion on a `done` Spec is not editable here, verified or not
//   ac-24  everything else STAYS editable — the over-blocking canary
//
// ac-24 is not decoration. The easy wrong implementation refuses every edit and
// passes both guard tests; it is caught only by asserting that the ordinary case
// still works, and by reading the statement back rather than trusting the call.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { tagAc } from "@memex-ai-ac/vitest";
import { db } from "../db/connection.js";
import { acs, documents, memexes, namespaces, testEventLatest, testEvents } from "../db/schema.js";
import { createAc, listAcsForBriefWithVerification, setAcAcceptance, updateAc } from "./acs.js";
import { createDocDraft, updateDocStatus } from "./documents.js";
import { makeTestMemex, seedTestEvent } from "./test-helpers.js";

const SPEC = "mindset-prod/memex-building-itself/specs/spec-566";

let memexId: string;
let namespaceSlug: string;
let memexSlug: string;
const createdDocIds: string[] = [];
const createdRefs: string[] = [];

type Seeded = { briefId: string; acId: string; ref: string; original: string };

/** A fresh Spec with one criterion on it. `green` seeds a passing emission. */
async function seedAc(opts: { green: boolean; statement?: string }): Promise<Seeded> {
  const original = opts.statement ?? "The nightly reconciliation job writes one summary row.";
  const doc = await createDocDraft(memexId, "update-guard fixture", "purpose", "spec");
  createdDocIds.push(doc.id);
  const ac = await createAc({
    memexId,
    briefId: doc.id,
    kind: "implementation",
    statement: original,
  });
  const ref = `${namespaceSlug}/${memexSlug}/specs/${doc.handle}/acs/ac-${ac.seq}`;
  createdRefs.push(ref);
  if (opts.green) {
    await seedTestEvent({
      subjectRef: ref,
      status: "pass",
      testIdentifier: "packages/server/src/reconcile.test.ts::writes one row",
    });
  }
  return { briefId: doc.id, acId: ac.id, ref, original };
}

async function stateOf(briefId: string, acId: string): Promise<string> {
  const rows = await listAcsForBriefWithVerification(memexId, briefId);
  const found = rows.find((r) => r.ac.id === acId);
  if (!found) throw new Error(`AC ${acId} vanished from the snapshot read`);
  return found.verificationState;
}

async function statementOf(acId: string): Promise<string> {
  const row = await db.query.acs.findFirst({ where: eq(acs.id, acId) });
  if (!row) throw new Error(`AC ${acId} not found`);
  return row.statement;
}

beforeAll(async () => {
  memexId = await makeTestMemex("upg566");
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
    await db
      .delete(testEventLatest)
      .where(inArray(testEventLatest.subjectRef, createdRefs))
      .catch(() => {});
    await db.delete(testEvents).where(inArray(testEvents.subjectRef, createdRefs)).catch(() => {});
  }
  if (createdDocIds.length) {
    await db.delete(documents).where(inArray(documents.id, createdDocIds)).catch(() => {});
  }
  const [row] = await db
    .select({ namespaceId: memexes.namespaceId })
    .from(memexes)
    .where(eq(memexes.id, memexId))
    .limit(1);
  if (row) await db.delete(namespaces).where(eq(namespaces.id, row.namespaceId)).catch(() => {});
});

describe("spec-566 t-3 — update_ac refuses a criterion that already reads as satisfied [dec-8]", () => {
  it("refuses a VERIFIED criterion and names the proposal path, leaving the statement untouched", async () => {
    tagAc(`${SPEC}/acs/ac-23`);

    const { briefId, acId, original } = await seedAc({ green: true });
    // Precondition asserted, not assumed: a criterion that was not actually green
    // would make the refusal below prove nothing about dec-8.
    expect(await stateOf(briefId, acId)).toBe("verified");

    await expect(updateAc(memexId, acId, "a quietly easier claim")).rejects.toThrow(
      /supersession/i,
    );

    // std-53: the refusal states the OUTCOME and names the call that clears it.
    // "This criterion is verified" would be a defect report, not a message.
    await expect(updateAc(memexId, acId, "a quietly easier claim")).rejects.toThrow(
      /propose_ac_supersession/,
    );

    // And nothing was written on the way to refusing.
    expect(await statementOf(acId)).toBe(original);
  });

  it("refuses a MANUALLY ACCEPTED criterion too — spec-188's overlay is the same green", async () => {
    tagAc(`${SPEC}/acs/ac-23`);

    // Reading of ac-23 stated in the implementation: "currently reads as
    // satisfied" covers spec-188's manual-acceptance overlay, not only
    // test-derived `verified`. An `accepted` criterion presents as satisfied on
    // every coverage surface, so leaving it editable would keep the door this
    // decision closes open via the other hinge.
    const { briefId, acId, original } = await seedAc({ green: false });
    await setAcAcceptance(memexId, acId, "QA reviewer");
    expect(await stateOf(briefId, acId)).toBe("accepted");

    await expect(updateAc(memexId, acId, "a quietly easier claim")).rejects.toThrow(
      /supersession/i,
    );
    expect(await statementOf(acId)).toBe(original);
  });
});

describe("spec-566 t-3 — update_ac refuses on a closed Spec [dec-9]", () => {
  it("refuses an UNVERIFIED criterion on a `done` Spec and names the reopen path", async () => {
    tagAc(`${SPEC}/acs/ac-26`);

    // The UNVERIFIED case specifically: a verified criterion is already refused by
    // guard 1, so testing that case would prove nothing about the population this
    // second guard actually adds.
    const { briefId, acId, original } = await seedAc({ green: false });
    expect(await stateOf(briefId, acId)).toBe("untested");

    // Editable right up until the Spec closes — the same criterion, one status apart.
    const edited = await updateAc(memexId, acId, "still freely editable while open");
    expect(edited.statement).toBe("still freely editable while open");

    await updateDocStatus(memexId, briefId, "done");

    await expect(updateAc(memexId, acId, "a change after the fact")).rejects.toThrow(/reopen/i);
    expect(await statementOf(acId)).toBe("still freely editable while open");
    expect(original).not.toBe("a change after the fact"); // fixture sanity
  });
});

describe("spec-566 t-3 — the over-blocking canary [ac-24]", () => {
  it("leaves an unverified criterion freely editable in every phase before done", async () => {
    tagAc(`${SPEC}/acs/ac-24`);

    const { briefId, acId } = await seedAc({ green: false });
    expect(await stateOf(briefId, acId)).toBe("untested");

    // dec-8 constrains the VERIFIED population only, and dec-9 the closed one. An
    // implementation that refuses every edit passes both guard tests above; this
    // is the assertion that catches it. Read the statement BACK each time — a call
    // that returned a plausible object without writing would pass a weaker test.
    for (const phase of ["specify", "build", "verify"]) {
      await updateDocStatus(memexId, briefId, phase);
      const next = `edited while the Spec is in ${phase}`;
      const returned = await updateAc(memexId, acId, next);
      expect(returned.statement).toBe(next);
      expect(await statementOf(acId), `edit must land in phase ${phase}`).toBe(next);
    }
  });

  it("leaves a FAILING and a STALE criterion editable — neither reads as satisfied", async () => {
    tagAc(`${SPEC}/acs/ac-24`);

    // The interesting half of the over-blocking risk: an implementation that
    // guards "has any test evidence" rather than "currently reads as satisfied"
    // would strand exactly the criteria most likely to need rewording — the ones
    // whose tests are red or gone quiet.
    const failing = await seedAc({ green: false, statement: "a criterion with a red test" });
    await seedTestEvent({
      subjectRef: failing.ref,
      status: "fail",
      testIdentifier: "packages/server/src/reconcile.test.ts::writes one row",
    });
    expect(await stateOf(failing.briefId, failing.acId)).toBe("failing");
    const fixedWording = "a criterion with a red test, reworded";
    await updateAc(memexId, failing.acId, fixedWording);
    expect(await statementOf(failing.acId)).toBe(fixedWording);

    const stale = await seedAc({ green: false, statement: "a criterion gone quiet" });
    await seedTestEvent({
      subjectRef: stale.ref,
      status: "pass",
      testIdentifier: "packages/server/src/quiet.test.ts::passes",
      // Older than STALE_THRESHOLD_DAYS (7), so it derives `stale`, not `verified`.
      createdAt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
    });
    expect(await stateOf(stale.briefId, stale.acId)).toBe("stale");
    const restated = "a criterion gone quiet, restated";
    await updateAc(memexId, stale.acId, restated);
    expect(await statementOf(stale.acId)).toBe(restated);
  });
});
