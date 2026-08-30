// spec-520 t-12 (ac-13) — the request path's role cannot drop a partition.
//
// ac-13 requires partition maintenance to run "as the owning role from deploy or cron,
// never from the request path, whose non-owner runtime role cannot drop a partition". This
// file is the second half of that: it runs under the restricted `memex_app` role (only
// vitest.rls.config.ts includes *.rls-restricted.test.ts) and asserts the refusal.
//
// ⚠ WHAT THIS PROVES, AND WHAT IT DOES NOT. It proves the MECHANISM: a non-owner is refused
// by Postgres, so a maintenance path that accidentally ran in-process would fail loudly
// rather than quietly delete a day of emissions.
//
// It does NOT prove production is wired that way today, and it cannot. deploy.sh currently
// reads:
//
//     RUNTIME_DB_USER="${RUNTIME_DB_USER:-$DB_USER}"
//
// — the runtime role DEFAULTS TO THE OWNER until t-14 rolls the split out per environment.
// So in production right now the request path's role IS the owner and could drop a
// partition. That is a fact about sequencing, not a gap in this task: t-14 exists to close
// it, and the environment-level proof belongs there. Recorded on t-12 rather than left to
// look like missing coverage.

import { describe, it, expect } from "vitest";
import { sql } from "drizzle-orm";
import { tagAc } from "@memex-ai-ac/vitest";
import { db } from "../db/connection.js";

const AC_PARTITIONED = "mindset-prod/memex-building-itself/specs/spec-520/acs/ac-13";

/**
 * Run a statement and return the POSTGRES error code.
 *
 * ⚠ NOT the message. Drizzle wraps driver errors, so `.message` is "Failed query: …" and a
 * regex on it matches nothing useful — a `/must be owner/` assertion fails even when the
 * refusal happened exactly as intended. The real error hangs off `.cause`, and `42501`
 * (insufficient_privilege) is the code that says "this role is not the owner". Asserting
 * the code also means the test cannot pass because a statement was malformed.
 */
async function errorCodeOf(statement: string): Promise<string | undefined> {
  try {
    await db.execute(sql.raw(statement));
    return undefined;
  } catch (err) {
    const cause = (err as { cause?: { code?: string } }).cause;
    return cause?.code;
  }
}

async function anyPartitionName(): Promise<string> {
  const rows = (await db.execute(sql`
    SELECT c.relname::text AS name
    FROM pg_class c
    JOIN pg_inherits i ON i.inhrelid = c.oid
    WHERE i.inhparent = 'test_events'::regclass
    ORDER BY c.relname
    LIMIT 1
  `)) as unknown as Array<{ name: string }>;
  return rows[0]!.name;
}

describe("spec-520 ac-13 — partition maintenance is refused to the restricted role", () => {
  it("confirms this suite really is connected as the non-owner role", async () => {
    tagAc(AC_PARTITIONED);
    const [row] = (await db.execute(sql`SELECT current_user::text AS who`)) as unknown as Array<{ who: string }>;
    // Without this the refusals below could pass because the statements were malformed
    // rather than because the role lacked the right — the two are indistinguishable from a
    // thrown error alone.
    expect(row.who).toBe("memex_app");
  });

  it("refuses DROP TABLE on a partition", async () => {
    tagAc(AC_PARTITIONED);
    const name = await anyPartitionName();
    expect(await errorCodeOf(`DROP TABLE ${name}`)).toBe("42501");
  });

  it("refuses DETACH PARTITION on the parent", async () => {
    tagAc(AC_PARTITIONED);
    const name = await anyPartitionName();
    // The maintenance script detaches before dropping, so both verbs have to be refused —
    // a role that could detach could strand a partition outside the parent, which reads as
    // silent data loss to every consumer.
    expect(await errorCodeOf(`ALTER TABLE test_events DETACH PARTITION ${name}`)).toBe("42501");
  });

  it("still lets the restricted role do what the emission path needs", async () => {
    tagAc(AC_PARTITIONED);
    // The refusals above would be trivially satisfiable by a role with no rights at all.
    // This is the other side: the same role must still be able to write emissions, or the
    // "restrict it" answer would have broken the product to secure it.
    const [row] = (await db.execute(sql`
      SELECT has_table_privilege('test_events', 'INSERT') AS ins,
             has_table_privilege('test_events', 'SELECT') AS sel
    `)) as unknown as Array<{ ins: boolean; sel: boolean }>;
    expect(row.ins).toBe(true);
    expect(row.sel).toBe(true);
  });
});
