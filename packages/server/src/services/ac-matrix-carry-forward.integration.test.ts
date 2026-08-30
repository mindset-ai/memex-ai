// spec-520 dec-9 (ac-42) — a pair whose emissions have all left the retention window still
// reports its last known state instead of an empty grid.
//
// THE NUMBER THAT FORCED THIS. t-12 swaps count-based retention ("latest 10 per pair, any
// age") for a time window. Those rules are not interchangeable: a pair that ran ten times
// in March keeps all ten today and would keep none under a window. Measured on prod
// 2026-08-30, BEFORE any swap — 196,978 of 243,339 pairs have not run in three days.
// **81%.**
//
// The verification badge reads test_event_latest, which retention has never touched
// (spec-398 ac-8 guarantees it). The evidence grid reads test_events. So without this, four
// out of five ACs would render "Verified" above an EMPTY matrix — the two halves of one tab
// contradicting each other, and the half that looks broken being the one that carries the
// proof.
//
// WHY A SEPARATE FIELD AND NOT A SYNTHETIC EMISSION. The matrix UI lays emissions out on a
// shared TIME AXIS by emittedAt. A fabricated entry dated three months back would be
// positioned off the axis, and worse, it would claim to be a run inside the window. ac-42
// asks for it "marked as a carried-forward summary rather than presented as a run" — so it
// is literally not in the emissions list. Nothing in the existing layout logic changes.
//
// HOW A DARK PAIR IS SIMULATED. No window exists yet, so the test deletes the raw rows and
// keeps the summary — which is exactly the state t-12 will produce for a pair whose last
// run predates the window.

import { describe, it, expect, afterAll, beforeAll } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import { tagAc } from "@memex-ai-ac/vitest";
import { db } from "../db/connection.js";
import { documents, memexes, namespaces, testEventLatest, testEvents } from "../db/schema.js";
import { createAc, listTestEventDigestForAc, listTestMatrixForAc } from "./acs.js";
import { createDocDraft } from "./documents.js";
import { makeTestMemex, seedTestEvent } from "./test-helpers.js";

const AC_CARRY = "mindset-prod/memex-building-itself/specs/spec-520/acs/ac-42";

let memexId: string;
let namespaceSlug: string;
let memexSlug: string;
const createdDocIds: string[] = [];
const createdRefs: string[] = [];

async function seedAc(statement: string): Promise<{ acId: string; ref: string }> {
  const doc = await createDocDraft(memexId, "carry forward", "purpose", "spec");
  createdDocIds.push(doc.id);
  const ac = await createAc({ memexId, briefId: doc.id, kind: "implementation", statement });
  const ref = `${namespaceSlug}/${memexSlug}/specs/${doc.handle}/acs/ac-${ac.seq}`;
  createdRefs.push(ref);
  return { acId: ac.id, ref };
}

/** Emit, then drop the raw rows — the shape a time window leaves behind for a dark pair. */
async function goDark(
  ref: string,
  testIdentifier: string,
  status: "pass" | "fail" | "error",
  at: Date,
): Promise<void> {
  await seedTestEvent({ subjectRef: ref, status, testIdentifier, createdAt: at });
  await db
    .delete(testEvents)
    .where(and(eq(testEvents.subjectRef, ref), eq(testEvents.testIdentifier, testIdentifier)));
}

beforeAll(async () => {
  memexId = await makeTestMemex("d9cf");
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
    await db.delete(testEventLatest).where(inArray(testEventLatest.subjectRef, createdRefs)).catch(() => {});
    await db.delete(testEvents).where(inArray(testEvents.subjectRef, createdRefs)).catch(() => {});
  }
  if (createdDocIds.length) {
    await db.delete(documents).where(inArray(documents.id, createdDocIds)).catch(() => {});
  }
});

describe("spec-520 ac-42: the matrix carries a dark pair's last known state forward", () => {
  it("reports the pair with an empty emission list and a carried-forward summary", async () => {
    tagAc(AC_CARRY);
    const { acId, ref } = await seedAc("dark pair");
    const lastRun = new Date("2026-06-12T09:00:00Z");
    await goDark(ref, "a::t", "pass", lastRun);

    const rows = await listTestMatrixForAc(memexId, acId);
    const row = rows.find((r) => r.testIdentifier === "a::t");
    // Without the fallback the pair is absent entirely — not an empty row, no row at all.
    expect(row, "a dark pair must still appear in the matrix").toBeDefined();
    expect(row!.emissions).toHaveLength(0);
    expect(row!.carriedForward).not.toBeNull();
    expect(row!.carriedForward!.status).toBe("pass");
    expect(row!.carriedForward!.emittedAt.toISOString()).toBe(lastRun.toISOString());
  });

  it("leaves a pair that still has rows in the window untouched", async () => {
    tagAc(AC_CARRY);
    const { acId, ref } = await seedAc("live pair");
    await seedTestEvent({ subjectRef: ref, status: "pass", testIdentifier: "a::t", createdAt: new Date() });

    const row = (await listTestMatrixForAc(memexId, acId)).find((r) => r.testIdentifier === "a::t")!;
    expect(row.emissions).toHaveLength(1);
    // The fallback is for absence of evidence, not a decoration on evidence that exists.
    expect(row.carriedForward).toBeNull();
  });

  it("carries forward a RED last-known state, not just a green one", async () => {
    tagAc(AC_CARRY);
    const { acId, ref } = await seedAc("dark and red");
    await goDark(ref, "a::t", "fail", new Date("2026-06-12T09:00:00Z"));

    const row = (await listTestMatrixForAc(memexId, acId)).find((r) => r.testIdentifier === "a::t")!;
    // Only carrying greens forward would turn the fallback into a way of hiding failures.
    expect(row.carriedForward!.status).toBe("fail");
  });

  it("does not invent a row for a pair that only ever had hidden emissions", async () => {
    tagAc(AC_CARRY);
    const { acId, ref } = await seedAc("hidden only");
    await seedTestEvent({
      subjectRef: ref, status: "pass", testIdentifier: "h::t", createdAt: new Date(), hidden: true,
    });

    // Hidden emissions never reach test_event_latest (applyEmissionToSummary returns early),
    // and the matrix excludes them. Enumerating pairs from the summary must not change that.
    const rows = await listTestMatrixForAc(memexId, acId);
    expect(rows.find((r) => r.testIdentifier === "h::t")).toBeUndefined();
  });
});

describe("spec-520 ac-42: the digest does the same without losing what it already reported", () => {
  it("reports a dark pair with a zero count and its last known verdict", async () => {
    tagAc(AC_CARRY);
    const { acId, ref } = await seedAc("digest dark");
    await goDark(ref, "a::t", "pass", new Date("2026-06-12T09:00:00Z"));

    const row = (await listTestEventDigestForAc(memexId, acId)).find((r) => r.testIdentifier === "a::t");
    expect(row, "a dark pair must still appear in the digest").toBeDefined();
    // Zero is the honest audit depth — no rows are retained. The verdict is still known.
    expect(row!.count).toBe(0);
    expect(row!.latestStatus).toBe("pass");
    expect(row!.carriedForward).toBe(true);
    expect(row!.hidden).toBe(false);
  });

  it("still reports a hidden-only pair, which has rows but NO summary row", async () => {
    tagAc(AC_CARRY);
    const { acId, ref } = await seedAc("digest hidden only");
    await seedTestEvent({
      subjectRef: ref, status: "pass", testIdentifier: "h::t", createdAt: new Date(), hidden: true,
    });

    // The digest now has to enumerate pairs from BOTH test_events and test_event_latest.
    // Switching to the summary alone would silently drop fully-retired pairs — repairing
    // dark pairs by losing hidden ones.
    const row = (await listTestEventDigestForAc(memexId, acId)).find((r) => r.testIdentifier === "h::t");
    expect(row, "a hidden-only pair has no summary row and must not vanish").toBeDefined();
    expect(row!.count).toBe(1);
    expect(row!.hidden).toBe(true);
    expect(row!.latestStatus).toBeNull();
    expect(row!.carriedForward).toBe(false);
  });

  it("leaves a live pair reporting its real count", async () => {
    tagAc(AC_CARRY);
    const { acId, ref } = await seedAc("digest live");
    await seedTestEvent({ subjectRef: ref, status: "fail", testIdentifier: "a::t", createdAt: new Date() });

    const row = (await listTestEventDigestForAc(memexId, acId)).find((r) => r.testIdentifier === "a::t")!;
    expect(row.count).toBe(1);
    expect(row.carriedForward).toBe(false);
    expect(row.pinning).toBe(true);
  });
});
