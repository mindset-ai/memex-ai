// spec-440 ac-11: the gated-table set is a SINGLE SOURCE OF TRUTH that cannot
// silently drift from the migrations. RLS_TENANT_TABLES is hand-maintained, so
// this test pins it to the live schema: it must EXACTLY equal the set of tables
// carrying a `*_memex_isolation` policy in pg_policies. Add a gated table (or
// drop a policy) in a migration without updating the constant → this fails CI.
//
// Runs against the local test DB as the owner role (a catalog read); it asserts
// what the schema actually enforces, independent of which role the app connects
// as at runtime.

import { describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { tagAc } from "@memex-ai-ac/vitest";
import { db } from "./connection.js";
import { RLS_TENANT_TABLES } from "./rls-tables.js";

const AC_11 = "mindset-prod/memex-building-itself/specs/spec-440/acs/ac-11";

describe("spec-440 ac-11: RLS_TENANT_TABLES matches the live *_memex_isolation policy set", () => {
  it("the constant equals pg_policies' _memex_isolation tables, exactly (no drift)", async () => {
    tagAc(AC_11);

    const rows = (await db.execute(sql`
      SELECT tablename
      FROM pg_policies
      WHERE policyname LIKE '%\\_memex\\_isolation'
      ORDER BY tablename
    `)) as unknown as Array<{ tablename: string }>;

    const live = new Set(rows.map((r) => r.tablename));
    const declared = new Set(RLS_TENANT_TABLES);

    // Symmetric difference, reported both ways so a failure names the exact gap.
    const missingFromConstant = [...live].filter((t) => !declared.has(t)).sort();
    const staleInConstant = [...declared].filter((t) => !live.has(t)).sort();

    expect(
      missingFromConstant,
      `gated tables in the schema but NOT in RLS_TENANT_TABLES (add them): ${missingFromConstant.join(", ")}`,
    ).toEqual([]);
    expect(
      staleInConstant,
      `tables in RLS_TENANT_TABLES with NO live _memex_isolation policy (remove them): ${staleInConstant.join(", ")}`,
    ).toEqual([]);

    // Sanity: the set is non-empty (a broken query returning 0 rows would make
    // the two "empty diff" assertions vacuously pass).
    expect(live.size).toBeGreaterThan(0);
  });
});
