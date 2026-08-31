// spec-520 dec-7 option D / ac-34 — the first-verified upsert stops rewriting a row it is
// not changing.
//
// THE WASTE. `recordFirstVerified` runs on every non-hidden PASSING emission and does
// `ON CONFLICT DO UPDATE SET first_verified_at = LEAST(existing, EXCLUDED)`. After the
// first pass LEAST always returns the value ALREADY STORED — so every subsequent write
// stores an identical value and still creates a new row version. Measured on prod
// 2026-08-28 as a 600s delta: 30.972 calls/s at 0.0496 ms, one per event, ~21.3M lifetime
// updates that changed nothing.
//
// ⚠ THE TEST-DESIGN TRAP, and it is the whole reason this file reads the way it does.
// Asserting the stored VALUE is unchanged proves NOTHING here: LEAST already returns the
// same value with or without the fix. A value assertion passes identically against the
// wasteful implementation and the fixed one. What has to be observed is whether the ROW
// WAS REWRITTEN — so these tests read `xmin`, the system column holding the transaction
// that last wrote the row. Same value + same xmin = the statement found no row. Same value
// + new xmin = the waste is still there.
//
// The second arm matters as much as the first: LEAST-wins exists for OUT-OF-ORDER arrival
// (replays, backfills). A predicate that suppresses ALL conflicts rather than only the
// ones where the stored value is already at or before the incoming one would silently turn
// "earliest pass" into "first pass SEEN" — and no test asserting only the no-op case would
// catch it.

import { describe, it, expect, afterAll, beforeAll } from "vitest";
import { inArray, sql } from "drizzle-orm";
import { tagAc } from "@memex-ai-ac/vitest";
import { db } from "../db/connection.js";
import { acFirstVerified } from "../db/schema.js";
import { recordFirstVerified } from "./test-event-retention.js";
import { makeTestMemex } from "./test-helpers.js";

const AC_THROTTLE = "mindset-prod/memex-building-itself/specs/spec-520/acs/ac-34";

// spec-520 ac-23 is the COMPOSITE statement of what dec-7 actually delivered, so it is
// tagged from BOTH halves — the tenancy work here and the throttle in
// first-verified-throttle.integration.test.ts. Tagging it from either alone would flip it
// green on half its claim, which is exactly the mistake ac-24/ac-25 made earlier in this
// Spec and why ac-35/ac-36 had to be split out of them.
const AC_DEC7 = "mindset-prod/memex-building-itself/specs/spec-520/acs/ac-23";


const RUN = `spec520-d-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
// spec-520 dec-7 option C: ac_first_verified now carries memex_id, so the writer needs a
// real tenant. Under the default OWNER connection RLS is bypassed (std-36: ENABLE, never
// FORCE), so this file still exercises the throttle rather than the policy — the policy is
// proven separately under the restricted role.
let memexId: string;
const refs: string[] = [];

function refFor(name: string): string {
  const r = `mindset-prod/fixture/specs/spec-1/acs/${RUN}-${name}`;
  refs.push(r);
  return r;
}

/** The stored date AND the row version that produced it. */
async function readRow(subjectRef: string): Promise<{ at: string; xmin: string } | null> {
  const rows = await db.execute(sql`
    SELECT first_verified_at::text AS at, xmin::text AS xmin
      FROM ac_first_verified WHERE subject_ref = ${subjectRef}
  `);
  const r = (rows as unknown as { at: string; xmin: string }[])[0];
  return r ?? null;
}

beforeAll(async () => {
  memexId = await makeTestMemex("d");
  await db.delete(acFirstVerified).where(inArray(acFirstVerified.subjectRef, refs)).catch(() => {});
});

afterAll(async () => {
  if (refs.length) {
    await db
      .delete(acFirstVerified)
      .where(inArray(acFirstVerified.subjectRef, refs))
      .catch(() => {});
  }
});

describe("spec-520 ac-34: first-verified is written once, not on every passing event", () => {
  it("writes on the first pass", async () => {
    tagAc(AC_THROTTLE);
    tagAc(AC_DEC7);
    const ref = refFor("first");
    expect(await readRow(ref)).toBeNull();

    await recordFirstVerified(db, ref, new Date("2026-08-20T10:00:00.000Z"), memexId);
    const row = await readRow(ref);
    expect(row).not.toBeNull();
    expect(new Date(row!.at).toISOString()).toBe("2026-08-20T10:00:00.000Z");
  });

  it("does NOT rewrite the row for a LATER pass — same value AND same row version", async () => {
    tagAc(AC_THROTTLE);
    tagAc(AC_DEC7);
    const ref = refFor("later");
    await recordFirstVerified(db, ref, new Date("2026-08-20T10:00:00.000Z"), memexId);
    const before = await readRow(ref);

    // The ~31/s case: an AC that is already green keeps emitting.
    await recordFirstVerified(db, ref, new Date("2026-08-21T10:00:00.000Z"), memexId);
    const after = await readRow(ref);

    expect(after!.at).toBe(before!.at);
    // THE assertion. Without the predicate the value is identical and xmin MOVES, because
    // LEAST wrote the same date into a brand-new row version.
    expect(after!.xmin).toBe(before!.xmin);
  });

  it("does NOT rewrite the row for an IDENTICAL timestamp either", async () => {
    tagAc(AC_THROTTLE);
    tagAc(AC_DEC7);
    const ref = refFor("equal");
    const at = new Date("2026-08-20T10:00:00.000Z");
    await recordFirstVerified(db, ref, at, memexId);
    const before = await readRow(ref);

    await recordFirstVerified(db, ref, at, memexId);
    const after = await readRow(ref);
    expect(after!.xmin).toBe(before!.xmin);
  });

  it("STILL writes for a genuinely EARLIER pass — LEAST-wins survives the throttle", async () => {
    tagAc(AC_THROTTLE);
    tagAc(AC_DEC7);
    const ref = refFor("earlier");
    await recordFirstVerified(db, ref, new Date("2026-08-20T10:00:00.000Z"), memexId);
    const before = await readRow(ref);

    // Out-of-order arrival: a replay or backfill carrying an earlier first pass. This is
    // the arm a careless predicate breaks, turning "earliest" into "first seen".
    await recordFirstVerified(db, ref, new Date("2026-08-01T09:00:00.000Z"), memexId);
    const after = await readRow(ref);

    expect(new Date(after!.at).toISOString()).toBe("2026-08-01T09:00:00.000Z");
    expect(after!.xmin).not.toBe(before!.xmin);
  });

  it("touches only the ref it was given", async () => {
    tagAc(AC_THROTTLE);
    tagAc(AC_DEC7);
    const target = refFor("target");
    const bystander = refFor("bystander");
    await recordFirstVerified(db, bystander, new Date("2026-08-20T10:00:00.000Z"), memexId);
    const bystanderBefore = await readRow(bystander);

    await recordFirstVerified(db, target, new Date("2026-08-22T10:00:00.000Z"), memexId);

    // A predicate written without the id/ref conjunct in the right place could suppress or
    // rewrite unrelated rows; a single-ref assertion would never see it.
    const bystanderAfter = await readRow(bystander);
    expect(bystanderAfter!.xmin).toBe(bystanderBefore!.xmin);
    expect(bystanderAfter!.at).toBe(bystanderBefore!.at);
  });
});
