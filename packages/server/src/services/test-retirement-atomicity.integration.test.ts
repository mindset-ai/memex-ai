// spec-566 t-4 — the retirement and its receipt commit together, or neither does.
//
// WHY THIS IS ITS OWN FILE, and why the first instrument was wrong.
//
// The claim is: if the journal write fails, the `test_events` rows are STILL THERE.
// The first attempt injected the failure by passing an invalid `channel`, on the
// theory that the journal's `spec_lifecycle_events_channel_valid` CHECK would be
// what refused. A mutation probe killed that: wrapping the journal write in
// `.catch(() => undefined)` — making it exactly the best-effort write this Spec
// exists to replace — left the test GREEN. The rejection was never coming from the
// journal at all, so the test could not tell an atomic write from an advisory one.
//
// The instrument that DOES express the claim is to fail the journal module itself
// and nothing else. `vi.mock` is file-scoped, which is why this lives apart from
// test-retirement-journal.integration.test.ts rather than beside its siblings.

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { tagAc } from "@memex-ai-ac/vitest";

// Mocked BEFORE the service under test is imported. The factory throws the way a
// failed insert would, leaving every other part of the retirement real: the
// tenancy read, the hard delete, the summary drop and the enclosing transaction
// all run exactly as in production.
vi.mock("./lifecycle-journal.js", () => ({
  recordLifecycleEvent: vi.fn(async () => {
    throw new Error("simulated journal insert failure");
  }),
}));

const { db } = await import("../db/connection.js");
const { documents, memexes, namespaces, testEventLatest, testEvents } = await import(
  "../db/schema.js"
);
const { createAc, discontinueTestEventsForAc } = await import("./acs.js");
const { createDocDraft } = await import("./documents.js");
const { makeTestMemex, seedTestEvent } = await import("./test-helpers.js");

const SPEC = "mindset-prod/memex-building-itself/specs/spec-566";
const IDENTIFIER = "packages/server/src/exporter.test.ts::reconciles to the ledger";

let memexId: string;
let namespaceSlug: string;
let memexSlug: string;
const createdDocIds: string[] = [];
const createdRefs: string[] = [];

beforeAll(async () => {
  memexId = await makeTestMemex("atm566");
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

describe("spec-566 t-4 — a retirement whose receipt fails does not happen", () => {
  it("leaves the test_events rows and the summary in place when the journal write throws", async () => {
    tagAc(`${SPEC}/acs/ac-5`);

    const doc = await createDocDraft(memexId, "atomicity fixture", "purpose", "spec");
    createdDocIds.push(doc.id);
    const ac = await createAc({
      memexId,
      briefId: doc.id,
      kind: "implementation",
      statement: "The exporter reconciles to the ledger.",
    });
    const ref = `${namespaceSlug}/${memexSlug}/specs/${doc.handle}/acs/ac-${ac.seq}`;
    createdRefs.push(ref);
    await seedTestEvent({ subjectRef: ref, status: "pass", testIdentifier: IDENTIFIER });

    // Precondition: the evidence and its summary both exist, so "it survived" and
    // "it was never written" are distinguishable.
    const before = await db.select().from(testEvents).where(eq(testEvents.subjectRef, ref));
    expect(before.length).toBeGreaterThan(0);
    const summaryBefore = await db
      .select()
      .from(testEventLatest)
      .where(eq(testEventLatest.subjectRef, ref));
    expect(summaryBefore.length).toBeGreaterThan(0);

    await expect(
      discontinueTestEventsForAc(memexId, ac.id, IDENTIFIER, "a perfectly good reason", {
        channel: "mcp",
      }),
    ).rejects.toThrow(/journal/i);

    // The whole act rolled back. This is the property that separates this journal
    // from `persistEvent`, which swallows its own failures by design: a record
    // permitted to silently not exist is not a record, so the act it accompanies
    // must not stand without it.
    const after = await db.select().from(testEvents).where(eq(testEvents.subjectRef, ref));
    expect(after.length).toBe(before.length);
    const summaryAfter = await db
      .select()
      .from(testEventLatest)
      .where(eq(testEventLatest.subjectRef, ref));
    expect(summaryAfter.length).toBe(summaryBefore.length);
  });
});
