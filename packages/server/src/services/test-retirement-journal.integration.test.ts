// spec-566 t-4 — retiring a test's evidence leaves a tombstone, not a void.
//
// What is true on `develop` today, measured rather than assumed: retirement DOES
// write something — an `activity_log` row saying "ac updated". It names no test
// identifier, no reason and no commit; `sweepActivityLog` deletes it after
// PULSE_RETENTION_DAYS (default 30); and `persistEvent` swallows its own failures.
// Unnamed, expiring, best-effort. That is the gap, and it is narrower than "nothing
// is recorded" — which is why the Spec's Overview was corrected.
//
//   ac-5  the journal row names WHO, WHEN, WHY, the COMMIT, the test identifier
//         and the subject the evidence was tagged to
//
// Also asserted here, because no amount of reading the code settles it: the hard
// delete spec-358 dec-1 chose is UNCHANGED. This is a receipt, not a revival of
// `hidden`.
//
// The sibling claim — that a failed JOURNAL write takes the retirement down with it
// — is NOT in this file. Proving it needs the failure to originate in the journal
// and nowhere else, which means mocking that module, which is file-scoped. It lives
// in test-retirement-atomicity.integration.test.ts, and the header there records
// the mutation probe that caught an earlier version of it asserting nothing.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import { tagAc } from "@memex-ai-ac/vitest";
import { db } from "../db/connection.js";
import {
  acs,
  documents,
  memexes,
  namespaces,
  specLifecycleEvents,
  testEventLatest,
  testEvents,
  users,
} from "../db/schema.js";
import { createAc, discontinueTestEventsForAc } from "./acs.js";
import { createDocDraft } from "./documents.js";
import { makeTestMemex, seedTestEvent } from "./test-helpers.js";
import { upsertUserByEmail } from "./users.js";

const SPEC = "mindset-prod/memex-building-itself/specs/spec-566";

const IDENTIFIER = "packages/server/src/exporter.test.ts::reconciles to the ledger";
const COMMIT = "9f2c1ab";

let memexId: string;
let namespaceSlug: string;
let memexSlug: string;
let actorUserId: string;
const createdDocIds: string[] = [];
const createdRefs: string[] = [];

/** A criterion with one green emission, carrying a commit like a CI run does. */
async function seedRetirableAc(): Promise<{ briefId: string; acId: string; ref: string }> {
  const doc = await createDocDraft(memexId, "retirement fixture", "purpose", "spec");
  createdDocIds.push(doc.id);
  const ac = await createAc({
    memexId,
    briefId: doc.id,
    kind: "implementation",
    statement: "The exporter reconciles to the ledger.",
  });
  const ref = `${namespaceSlug}/${memexSlug}/specs/${doc.handle}/acs/ac-${ac.seq}`;
  createdRefs.push(ref);
  await seedTestEvent({
    subjectRef: ref,
    status: "pass",
    testIdentifier: IDENTIFIER,
    // spec-528 made commit_sha a COLUMN on test_events, filled from metadata.commit.
    metadata: { commit: COMMIT, branch: "develop" },
  });
  return { briefId: doc.id, acId: ac.id, ref };
}

async function journalFor(acId: string) {
  return db
    .select()
    .from(specLifecycleEvents)
    .where(
      and(eq(specLifecycleEvents.acId, acId), eq(specLifecycleEvents.kind, "test_retired")),
    );
}

beforeAll(async () => {
  memexId = await makeTestMemex("ret566");
  const [row] = await db
    .select({ m: memexes.slug, n: namespaces.slug })
    .from(memexes)
    .innerJoin(namespaces, eq(namespaces.id, memexes.namespaceId))
    .where(eq(memexes.id, memexId))
    .limit(1);
  memexSlug = row!.m;
  namespaceSlug = row!.n;
  // Per-worker-unique so parallel workers never collide on this row [std-37].
  const user = await upsertUserByEmail(`ret566-${process.pid}@example.test`);
  actorUserId = user.id;
});

afterAll(async () => {
  await db.delete(specLifecycleEvents).where(eq(specLifecycleEvents.memexId, memexId)).catch(() => {});
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
  if (actorUserId) await db.delete(users).where(eq(users.id, actorUserId)).catch(() => {});
});

describe("spec-566 t-4 — a retirement leaves a named, reasoned, durable receipt", () => {
  it("writes a journal row naming who, when, why, the commit, the identifier and the subject", async () => {
    tagAc(`${SPEC}/acs/ac-5`);

    const { acId, briefId, ref } = await seedRetirableAc();
    // Vacuity guard: the evidence must actually exist, or "it was deleted" and
    // "it was never there" are the same observation.
    const before = await db.select().from(testEvents).where(eq(testEvents.subjectRef, ref));
    expect(before.length).toBeGreaterThan(0);
    expect(await journalFor(acId)).toEqual([]);

    const result = await discontinueTestEventsForAc(
      memexId,
      acId,
      IDENTIFIER,
      "the test was deleted when the exporter moved to line-item granularity",
      { channel: "mcp", actorUserId, actorName: "LJ Retirer" },
    );
    expect(result.deleted).toBe(before.length);

    const rows = await journalFor(acId);
    expect(rows.length).toBe(1);
    const row = rows[0];

    // WHY — the actor's words, not a server-invented string [spec-127 dec-1].
    expect(row.reason).toBe(
      "the test was deleted when the exporter moved to line-item granularity",
    );
    // WHAT was retired, and WHAT it was attached to.
    expect(row.testIdentifier).toBe(IDENTIFIER);
    expect(row.subjectRef).toBe(ref);
    // AGAINST WHICH COMMIT — the commit the retired EVIDENCE carried. The server
    // has no idea what the retirer's HEAD is; claiming it would be fiction.
    expect(row.commitSha).toBe(COMMIT);
    // WHO / HOW / WHEN [std-32].
    expect(row.actorUserId).toBe(actorUserId);
    expect(row.actorName).toBe("LJ Retirer");
    expect(row.channel).toBe("mcp");
    expect(row.createdAt).toBeInstanceOf(Date);
    expect(row.briefId).toBe(briefId);
  });

  it("still HARD-DELETES the evidence — spec-358 dec-1's outcome is untouched", async () => {
    tagAc(`${SPEC}/acs/ac-5`);

    const { acId, ref } = await seedRetirableAc();
    await discontinueTestEventsForAc(memexId, acId, IDENTIFIER, "test removed in the repo", {
      channel: "rest_ui",
    });

    // The rows are GONE, not hidden. dec-3 is only defensible because this journal
    // is a receipt rather than a restore switch: if the evidence survived in some
    // soft-deleted form, this would be the `hidden` column spec-358 removed, under
    // a new name.
    const remaining = await db
      .select()
      .from(testEvents)
      .where(and(eq(testEvents.subjectRef, ref), eq(testEvents.testIdentifier, IDENTIFIER)));
    expect(remaining).toEqual([]);
    const summary = await db
      .select()
      .from(testEventLatest)
      .where(
        and(
          eq(testEventLatest.subjectRef, ref),
          eq(testEventLatest.testIdentifier, IDENTIFIER),
        ),
      );
    expect(summary).toEqual([]);
  });

  it("refuses a retirement with no stated reason, and deletes nothing [spec-127 dec-1]", async () => {
    tagAc(`${SPEC}/acs/ac-5`);

    const { acId, ref } = await seedRetirableAc();

    await expect(
      discontinueTestEventsForAc(memexId, acId, IDENTIFIER, "   ", { channel: "mcp" }),
    ).rejects.toThrow(/reason/i);

    // The refusal is total: the evidence is untouched. A guard that refuses AFTER
    // deleting would pass a test that only checked the throw.
    const still = await db.select().from(testEvents).where(eq(testEvents.subjectRef, ref));
    expect(still.length).toBeGreaterThan(0);
    expect(await journalFor(acId)).toEqual([]);
  });

  // ⚠ This test does NOT prove atomicity, and an earlier version of it claimed to.
  // It asserts only what it can see: an unattributable channel is refused and
  // nothing is deleted. The claim "a failed JOURNAL write leaves the evidence in
  // place" needs the failure to come from the journal and nowhere else, which
  // means mocking that module — file-scoped, so it lives in
  // test-retirement-atomicity.integration.test.ts. A mutation probe is what caught
  // the difference: making the journal write best-effort (`.catch(() => undefined)`)
  // left THIS test green and reds the one over there.
  it("refuses an unattributable channel and deletes nothing [std-32]", async () => {
    tagAc(`${SPEC}/acs/ac-5`);

    const { acId, ref } = await seedRetirableAc();

    await expect(
      discontinueTestEventsForAc(memexId, acId, IDENTIFIER, "a reason", {
        channel: "bogus_surface" as never,
      }),
    ).rejects.toThrow();

    // The refusal is total — nothing was deleted on the way to it.
    const survived = await db.select().from(testEvents).where(eq(testEvents.subjectRef, ref));
    expect(survived.length).toBeGreaterThan(0);
  });
});
