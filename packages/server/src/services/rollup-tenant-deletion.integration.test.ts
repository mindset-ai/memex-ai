// spec-520 t-13 (ac-30) — deleting a workspace must reach the per-day rollup.
//
// WHY THIS TABLE AND NOT THE OTHERS. Every table on the emission path has so far been
// forgiven by retention: the trim capped test_events, so a deleted tenant's rows aged out
// on their own. Retention was the de facto eraser. `test_run_daily` is PERMANENT by
// design — it exists precisely so history survives retention — and it grows per tenant,
// per subject, per test, per day, forever. Nothing will ever remove it on its own.
//
// WHAT THE INVESTIGATION FOUND (recorded on t-13):
//
//   1. There is NO production tenant-deletion path. The only DELETE against `memexes`,
//      `orgs` or `namespaces` in the whole server is the env-gated test surface. No route
//      on memexes.ts/orgs.ts deletes, and there is no soft-delete column.
//   2. Coverage for every other tenant table IS by construction — 16 tables carry an
//      ON DELETE CASCADE foreign key to `memexes`, and `acs`/`issues` inherit it
//      transitively through `documents`.
//   3. The emission family — test_events, test_event_latest, ac_first_verified and (as
//      shipped) test_run_daily — carries NO foreign key at all, direct or transitive. It
//      sits entirely outside the cascade graph.
//
// So the leak is latent rather than live: nothing deletes a tenant today, so nothing is
// orphaned yet. But when that path is built it will silently miss these four tables, and
// t-13 is explicit that coverage must be by construction rather than by someone
// remembering to add a line to an enumeration.
//
// THIS TEST DELETES THE ROW DIRECTLY, not through any service. That is deliberate: the
// guarantee has to hold for whatever code eventually issues the delete, including code
// that has never heard of this table. Going through a helper would prove only that the
// helper remembered.

import { describe, it, expect, afterAll, beforeAll } from "vitest";
import { eq, sql } from "drizzle-orm";
import { tagAc } from "@memex-ai-ac/vitest";
import { db } from "../db/connection.js";
import { memexes, testRunDaily } from "../db/schema.js";
import { makeTestMemex } from "./test-helpers.js";

const AC_DELETION = "mindset-prod/memex-building-itself/specs/spec-520/acs/ac-30";

let doomedMemexId: string;
let survivorMemexId: string;

async function seedRollup(memexId: string, subjectRef: string): Promise<void> {
  await db.insert(testRunDaily).values({
    memexId,
    subjectRef,
    testIdentifier: "a::t",
    day: "2026-08-30",
    runCount: 3,
    passCount: 3,
    failCount: 0,
    errorCount: 0,
  } as typeof testRunDaily.$inferInsert);
}

async function rollupRowsFor(memexId: string): Promise<number> {
  const rows = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(testRunDaily)
    .where(eq(testRunDaily.memexId, memexId));
  return Number(rows[0]?.n ?? 0);
}

beforeAll(async () => {
  doomedMemexId = await makeTestMemex("t13d");
  survivorMemexId = await makeTestMemex("t13s");
});

afterAll(async () => {
  await db.delete(testRunDaily).where(eq(testRunDaily.memexId, survivorMemexId)).catch(() => {});
  await db.delete(memexes).where(eq(memexes.id, survivorMemexId)).catch(() => {});
});

describe("spec-520 ac-30: workspace deletion reaches the rollup", () => {
  it("removes the rollup rows when the memex row is deleted, with no application code involved", async () => {
    tagAc(AC_DELETION);
    await seedRollup(doomedMemexId, "ns/mx/specs/spec-1/acs/ac-1");
    await seedRollup(doomedMemexId, "ns/mx/specs/spec-1/acs/ac-2");
    await seedRollup(survivorMemexId, "ns/other/specs/spec-1/acs/ac-1");
    expect(await rollupRowsFor(doomedMemexId)).toBe(2);

    // The raw row delete — the thing every future deletion path will ultimately do.
    await db.delete(memexes).where(eq(memexes.id, doomedMemexId));

    expect(await rollupRowsFor(doomedMemexId)).toBe(0);
    // A cascade that took the neighbours with it would be a far worse bug than the one
    // being fixed, and it would look like success from the doomed tenant's side.
    expect(await rollupRowsFor(survivorMemexId)).toBe(1);
  });

  it("holds the guarantee structurally — the constraint exists and cascades", async () => {
    tagAc(AC_DELETION);
    // The behavioural case above would keep passing if someone replaced the cascade with
    // an application-level cleanup. This asserts the guarantee is where t-13 requires it:
    // in the schema, reached automatically, not in a list somebody maintains.
    const rows = (await db.execute(sql`
      SELECT c.confdeltype::text AS on_delete
      FROM pg_constraint c
      WHERE c.contype = 'f'
        AND c.conrelid = 'test_run_daily'::regclass
        AND c.confrelid = 'memexes'::regclass
    `)) as unknown as Array<{ on_delete: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].on_delete).toBe("c"); // 'c' = ON DELETE CASCADE
  });
});
