// spec-566 t-1 — the lifecycle journal.
//
// Four writers converge on this table (test retirements t-4, AC status
// transitions t-6, gate overrides t-7, Spec reopens t-8) and dec-3 ruled it is
// BUILT ONCE. These tests pin the properties that make it a record rather than
// a feed:
//
//   ac-14  load-bearing fields are first-class columns, never a payload bag
//   ac-16  a failed write FAILS the operation it records — not advisory
//
// Hard rule, same as activity-log.test.ts: the persistence boundary is tested
// against REAL Postgres. The contrast that matters is with `persistEvent`
// (services/activity-log.ts), which swallows its own failures by design — this
// module must not.
//
// ac-15 (outside every retention path) and ac-17 (write-once) are claims about
// the ABSENCE of code, so they live in __regression__ as source scans; no
// passing test can express them.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq, inArray, sql } from "drizzle-orm";
import { tagAc } from "@memex-ai-ac/vitest";
import { db } from "../db/connection.js";
import { memexes, namespaces, specLifecycleEvents, users } from "../db/schema.js";
import { makeTestMemex } from "./test-helpers.js";
import { createDocDraft } from "./documents.js";
import { upsertUserByEmail } from "./users.js";
import { recordLifecycleEvent } from "./lifecycle-journal.js";

const SPEC = "mindset-prod/memex-building-itself/specs/spec-566";

let memexId: string;
let briefId: string;
let actorUserId: string;

beforeAll(async () => {
  memexId = await makeTestMemex("lj566");
  const doc = await createDocDraft(
    memexId,
    "Lifecycle journal fixture",
    "fixture for spec-566 t-1",
    "spec",
  );
  briefId = doc.id;
  // Per-worker-unique so parallel workers never collide on this row [std-37].
  const user = await upsertUserByEmail(`lj566-${process.pid}@example.test`);
  actorUserId = user.id;
});

afterAll(async () => {
  await db.delete(specLifecycleEvents).where(eq(specLifecycleEvents.memexId, memexId));
  const [row] = await db
    .select({ namespaceId: memexes.namespaceId })
    .from(memexes)
    .where(eq(memexes.id, memexId))
    .limit(1);
  if (row) await db.delete(namespaces).where(eq(namespaces.id, row.namespaceId));
  if (actorUserId) await db.delete(users).where(inArray(users.id, [actorUserId]));
});

describe("lifecycle journal — the record contract", () => {
  it("carries every load-bearing field as a first-class column, not a payload bag", async () => {
    tagAc(`${SPEC}/acs/ac-14`);

    // Introspect the real table rather than the Drizzle model: std-32's claim is
    // about the SCHEMA, and a model can drift from what was migrated.
    const cols = (await db.execute(sql`
      SELECT column_name, is_nullable
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'spec_lifecycle_events'
      ORDER BY column_name
    `)) as unknown as Array<{ column_name: string; is_nullable: string }>;

    // Vacuity guard: an empty result would satisfy the "no payload bag"
    // assertions below for the wrong reason — a table that does not exist has no
    // bag either.
    expect(cols.length).toBeGreaterThan(0);
    const names = new Set(cols.map((r) => r.column_name));

    // WHEN / WHO / HOW / WHAT-coarse — std-32's five, plus this journal's own
    // load-bearing fields. `reason` is the one every consumer filters on, so it
    // is the field most likely to be dumped into a bag; assert it hardest.
    for (const required of [
      "created_at",
      "actor_user_id",
      "actor_name",
      "channel",
      "memex_id",
      "brief_id",
      "kind",
      "reason",
      "commit_sha",
      "test_identifier",
    ]) {
      expect(names, `${required} must be a column [std-32]`).toContain(required);
    }

    // The inverse half: no free-form bag exists to hide a load-bearing field in.
    expect(names).not.toContain("payload");
    expect(names).not.toContain("metadata");
  });

  it("FAILS the operation when the DATABASE rejects the write — it is not advisory", async () => {
    tagAc(`${SPEC}/acs/ac-16`);

    // The claim under test is non-advisoriness, so the failure must come from the
    // DATABASE, not from our own hoisted validation — a rejection thrown before
    // the insert would pass this test while `persistEvent`-style swallowing sat
    // untouched underneath. Force a real FK violation with a well-formed, fully
    // valid input: only `memexId` is bogus, so every JS guard passes and the
    // driver is what refuses.
    await expect(
      recordLifecycleEvent({
        memexId: "00000000-0000-0000-0000-000000000000", // no such memex
        briefId: null,
        kind: "spec_reopened",
        reason: "reopened to correct a criterion",
        actorUserId,
        actorName: "LJ Actor",
        channel: "mcp",
      }),
    ).rejects.toThrow();

    // Vacuity guard: the same call with a real memex must LAND a row — otherwise
    // the rejection above proves nothing but a broken fixture.
    const ok = await recordLifecycleEvent({
      memexId,
      briefId,
      kind: "spec_reopened",
      reason: "reopened to correct a criterion",
      actorUserId,
      actorName: "LJ Actor",
      channel: "mcp",
    });
    expect(ok.id).toBeTruthy();
  });

  it("refuses an act with no stated reason, above the write [std-53]", async () => {
    tagAc(`${SPEC}/acs/ac-16`);

    await expect(
      recordLifecycleEvent({
        memexId,
        briefId,
        kind: "spec_reopened",
        reason: "   ", // blank after trim
        actorUserId,
        actorName: "LJ Actor",
        channel: "mcp",
      }),
    ).rejects.toThrow(/reason/i);

    // A retirement that cannot name its test is the same class of silent gap.
    await expect(
      recordLifecycleEvent({
        memexId,
        briefId,
        kind: "test_retired",
        reason: "test deleted in the repo",
        actorUserId,
        actorName: "LJ Actor",
        channel: "mcp",
      }),
    ).rejects.toThrow(/test identifier/i);
  });

  it("stamps actor_name at write, so a later rename cannot rewrite history", async () => {
    tagAc(`${SPEC}/acs/ac-14`);

    const written = await recordLifecycleEvent({
      memexId,
      briefId,
      kind: "test_retired",
      reason: "test deleted in the repo",
      testIdentifier: "packages/server/src/services/gone.test.ts::it works",
      commitSha: "abc1234",
      actorUserId,
      actorName: "LJ Actor",
      channel: "mcp",
    });

    await db.update(users).set({ name: "Renamed Later" }).where(eq(users.id, actorUserId));

    const [row] = await db
      .select()
      .from(specLifecycleEvents)
      .where(eq(specLifecycleEvents.id, written.id))
      .limit(1);

    expect(row.actorName).toBe("LJ Actor");
    expect(row.testIdentifier).toBe(
      "packages/server/src/services/gone.test.ts::it works",
    );
    expect(row.commitSha).toBe("abc1234");
  });
});
