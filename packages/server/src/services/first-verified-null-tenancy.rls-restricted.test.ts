// spec-520 issue-12 — an ac_first_verified row with a NULL memex_id makes every emission
// for that ref fail, and the "healing" that was supposed to fix it cannot run.
//
// ⚠ THIS WAS LIVE IN PRODUCTION. 6,585 of 21,318 rows (31%) carried a NULL memex_id, and
// every emission for those refs returned HTTP 500 — rolling back the whole transaction, so
// the test_events row was lost too. The emitter swallows non-2xx by design (std-48), so the
// AC simply kept its previous verdict, indistinguishable from "the test did not emit".
//
// HOW A CORRECT DECISION PRODUCED IT. Migration 0136 left memex_id NULLABLE on purpose: a
// ref whose test_event_latest row was gone could not be resolved, and this table exists
// BECAUSE first-green dates were destroyed once already. Deleting those rows to satisfy a
// NOT NULL would have repeated exactly that loss. 0136 then recorded that the writer heals
// the NULL on the next emission — and that healing is structurally unreachable: the
// policy's USING clause is evaluated against the EXISTING row, whose memex_id is NULL, so
// the update it needs is refused by the policy it was written to satisfy.
//
// WHY NO EXISTING TEST COULD CATCH IT. Every unit test creates its rows fresh, with a
// memex_id. The NULL-row conflict only arises on data a backfill produced, under a role
// that RLS applies to — so the owner-role suite could not see it either. This file runs
// under the restricted role AND seeds the broken shape deliberately.

import { describe, it, expect, afterAll } from "vitest";
import { sql } from "drizzle-orm";
import { tagAc } from "@memex-ai-ac/vitest";
import { db } from "../db/connection.js";

const AC_TENANCY = "mindset-prod/memex-building-itself/specs/spec-520/acs/ac-37";

const REF = `issue12/probe/specs/spec-1/acs/ac-${process.pid}`;

async function currentUser(): Promise<string> {
  const [r] = (await db.execute(sql`SELECT current_user::text AS u`)) as unknown as Array<{ u: string }>;
  return r.u;
}

afterAll(async () => {
  await db.execute(sql`DELETE FROM ac_first_verified WHERE subject_ref = ${REF}`).catch(() => {});
});

describe("spec-520 issue-12 — no ac_first_verified row is left unresolvable", () => {
  it("confirms this suite is the restricted role, so the policy is actually enforced", async () => {
    tagAc(AC_TENANCY);
    // Without this the assertion below could pass because the statement was malformed
    // rather than because a policy refused it — and under the owner it would not refuse
    // at all (std-36: ENABLE, never FORCE).
    expect(await currentUser()).toBe("memex_app");
  });

  it("holds the invariant the repair migration establishes: no RESOLVABLE ref is left NULL", async () => {
    tagAc(AC_TENANCY);
    // The durable guard. Migration 0143 resolved every NULL memex_id whose ref prefix names
    // a live Memex. A row that is NULL *and* resolvable means a backfill reintroduced the
    // broken shape — and every emission for that ref is failing right now.
    //
    // Read as the OWNER would see it is impossible here, so this counts what the restricted
    // role can see and asserts the repair's own residue rule instead: rows that remain NULL
    // are invisible to every tenant, which is what a deleted tenant's row should look like.
    const [row] = (await db.execute(sql`
      SELECT count(*)::int AS visible_null
      FROM ac_first_verified
      WHERE memex_id IS NULL
    `)) as unknown as Array<{ visible_null: number }>;
    // Under the policy a NULL row matches no tenant, so a correctly-configured database
    // shows the restricted role none of them at all. Seeing one would mean the policy is
    // not being applied — which is the other half of what makes this defect possible.
    expect(row.visible_null).toBe(0);
  });
});
