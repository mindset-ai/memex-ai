// spec-563 t-4 (ac-3) — the pattern is fixed, not just the one arm.
//
// ac-3 asks that "every UNION arm is walked and states where its memex_id comes from". A
// one-time walk recorded in prose rots the moment someone adds a ninth arm. This is the
// walk expressed as a guard.
//
// THE INVARIANT, and why it is spelled this way. pg_get_viewdef renders a column that is
// already named correctly as a BARE reference — `te.memex_id`, no alias. It only emits
// `AS memex_id` when the value is an EXPRESSION that needs renaming: a correlated
// subquery, a COALESCE, a join-recovered column. So:
//
//     the live definition contains `AS memex_id`  ⇔  some arm derives its tenant
//
// One assertion covers all eight arms and any arm added later, without naming them.
//
// ⚠ WHY THIS IS READ FROM THE CATALOGUE AND NOT FROM A MIGRATION FILE. activity_view is
// defined across six migrations, and 0142 recreates it dynamically from pg_get_viewdef
// without carrying its text — so no file in the repo is the view's definition [spec-564].
// Asserting against a file would test a fiction. This Spec's entire first draft was that
// mistake.

import { describe, it, expect } from "vitest";
import { sql } from "drizzle-orm";
import { tagAc } from "@memex-ai-ac/vitest";
import { db } from "../db/connection.js";

const AC = "mindset-prod/memex-building-itself/specs/spec-563/acs";

async function liveViewDef(): Promise<string> {
  const rows = (await db.execute(
    sql`SELECT pg_get_viewdef('activity_view'::regclass, true) AS def`,
  )) as unknown as { def: string }[];
  return rows[0].def;
}

describe("activity_view: no arm recovers its tenant [spec-563 t-4]", () => {
  it("ac-3: every UNION arm takes memex_id from a column, never from an expression", async () => {
    tagAc(`${AC}/ac-3`);

    const def = await liveViewDef();

    // Vacuity guard — if the view were missing or empty, every assertion below would pass
    // for the wrong reason (std-45 cl-4).
    expect(def.length).toBeGreaterThan(500);
    expect(def).toContain("UNION ALL");
    expect((def.match(/UNION ALL/g) ?? []).length).toBe(7); // 8 arms

    // The invariant. Before 0147 this failed on the doc_sections arm, whose tenant came
    // from `( SELECT pd.memex_id FROM documents pd WHERE pd.id = s.doc_id) AS memex_id`.
    expect(def).not.toMatch(/AS memex_id/);

    // And the specific shape that was there, named so a reader of a future failure knows
    // what it looked like rather than only that a regex tripped.
    expect(def).not.toContain("FROM documents pd");
  });

  it("ac-3: the guard above can fail — a derived tenant is detectable", async () => {
    tagAc(`${AC}/ac-3`);

    // Proving the invariant is not vacuous: build a view that DOES derive its tenant and
    // confirm the same assertion catches it. Without this, `not.toMatch` would pass just as
    // happily against a rendering convention that never emits `AS memex_id` at all — and
    // the guard would be decoration.
    const probe = `spec563_derived_tenant_probe_${process.env.VITEST_WORKER_ID ?? "0"}`;
    await db.execute(
      sql.raw(`
        CREATE OR REPLACE VIEW ${probe} AS
        SELECT s.id,
               (SELECT pd.memex_id FROM documents pd WHERE pd.id = s.doc_id) AS memex_id
          FROM doc_sections s`),
    );
    try {
      const rows = (await db.execute(
        sql.raw(`SELECT pg_get_viewdef('${probe}'::regclass, true) AS def`),
      )) as unknown as { def: string }[];
      expect(rows[0].def).toMatch(/AS memex_id/);
    } finally {
      await db.execute(sql.raw(`DROP VIEW IF EXISTS ${probe}`));
    }
  });

  it("ac-3: doc_sections supplies its own tenant, and it agrees with the document's", async () => {
    tagAc(`${AC}/ac-3`);

    // The column is denormalised from documents.memex_id. A denormalised column that can
    // disagree with its source is a tenancy bug waiting to happen, so assert the two never
    // diverge across every row present.
    const rows = (await db.execute(sql`
      SELECT count(*)::int AS total,
             count(*) FILTER (WHERE s.memex_id <> d.memex_id)::int AS mismatched
        FROM doc_sections s
        JOIN documents d ON d.id = s.doc_id
    `)) as unknown as { total: number; mismatched: number }[];

    expect(rows[0].mismatched).toBe(0);
  });
});
