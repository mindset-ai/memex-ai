// spec-520 dec-7 option C — ac_first_verified is tenancy-isolated, and the READ still works.
//
// Runs ONLY under vitest.rls.config.ts, as the restricted `memex_app` role. In the default
// owner-connection suite RLS is bypassed entirely (std-36: ENABLE, never FORCE), so every
// assertion here passes there for the wrong reason.
//
// WHY THIS FILE HAD TO EXIST BEFORE THE POLICY SHIPPED. issue-8 was the WRITE-side version
// of this trap: a context-less write to an RLS-gated table is rejected in prod while dev and
// CI stay green. This is the READ-side twin, and it is quieter — a context-less READ returns
// FEWER ROWS rather than an error, which is indistinguishable from "this AC never went
// green". The chart would simply flatten to zero and nobody would get an exception.
//
// dec-7 named it as a build constraint: "confirm the read is ALS-wrapped before enabling the
// policy, or the chart silently returns nothing under the non-owner role."

import { describe, it, expect, afterAll, beforeAll } from "vitest";
import { eq, inArray, sql } from "drizzle-orm";
import { tagAc } from "@memex-ai-ac/vitest";
import { db, runWithMemexId } from "../db/connection.js";
import { acFirstVerified, acs, documents, memexes, namespaces, users } from "../db/schema.js";
import { createDocDraft } from "../services/documents.js";
import { recordFirstVerified } from "../services/test-event-retention.js";
import { acsOverTime } from "../services/analytics.js";
import { upsertUserByEmail } from "../services/users.js";
import { ensureUserNamespace } from "../services/user-namespaces.js";

const AC_TENANCY = "mindset-prod/memex-building-itself/specs/spec-520/acs/ac-37";

// spec-520 ac-23 is the COMPOSITE statement of what dec-7 actually delivered, so it is
// tagged from BOTH halves — the tenancy work here and the throttle in
// first-verified-throttle.integration.test.ts. Tagging it from either alone would flip it
// green on half its claim, which is exactly the mistake ac-24/ac-25 made earlier in this
// Spec and why ac-35/ac-36 had to be split out of them.
const AC_DEC7 = "mindset-prod/memex-building-itself/specs/spec-520/acs/ac-23";


const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
let memexId: string;
let userId: string;
let namespaceSlug: string;
let docId: string;
let acRef: string;

beforeAll(async () => {
  const user = await upsertUserByEmail(`spec520-c-${runId}@example.com`);
  userId = user.id;
  const created = await ensureUserNamespace(userId);
  memexId = created.memex.id;
  const [ns] = await db
    .select({ slug: namespaces.slug })
    .from(namespaces)
    .where(eq(namespaces.id, created.memex.namespaceId))
    .limit(1);
  namespaceSlug = ns!.slug;

  await runWithMemexId(memexId, async () => {
    const doc = await createDocDraft(memexId, `spec520 optC ${runId}`, "", "spec");
    docId = doc.id;
    await db.insert(acs).values({
      memexId,
      briefId: docId,
      seq: 1,
      kind: "implementation",
      statement: "the criterion that went green",
      status: "active",
    } as typeof acs.$inferInsert);
    acRef = `${namespaceSlug}/${created.memex.slug}/specs/${doc.handle}/acs/ac-1`;
  });
});

afterAll(async () => {
  await runWithMemexId(memexId, async () => {
    await db.delete(acFirstVerified).where(eq(acFirstVerified.subjectRef, acRef)).catch(() => {});
    if (docId) await db.delete(documents).where(eq(documents.id, docId)).catch(() => {});
  });
  await db.delete(memexes).where(eq(memexes.id, memexId)).catch(() => {});
  await db.delete(namespaces).where(eq(namespaces.slug, namespaceSlug)).catch(() => {});
  await db.delete(users).where(inArray(users.id, [userId])).catch(() => {});
});

describe("spec-520 ac-37: ac_first_verified is isolated, and its reader still sees its own rows", () => {
  it("a write from the emission path satisfies the policy", async () => {
    tagAc(AC_TENANCY);
    tagAc(AC_DEC7);
    // The WRITE half. Under memex_app this INSERT's WITH CHECK is evaluated for real; the
    // emission route runs inside runWithMemexId (issue-8), which is what makes it satisfiable.
    await runWithMemexId(memexId, async () =>
      recordFirstVerified(db, acRef, new Date("2026-08-20T10:00:00.000Z"), memexId),
    );

    const rows = await runWithMemexId(memexId, async () =>
      db
        .select({ at: acFirstVerified.firstVerifiedAt, memexId: acFirstVerified.memexId })
        .from(acFirstVerified)
        .where(eq(acFirstVerified.subjectRef, acRef)),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.memexId).toBe(memexId);
  });

  it("THE READ WORKS under the restricted role — acsOverTime still counts the first pass", async () => {
    tagAc(AC_TENANCY);
    tagAc(AC_DEC7);

    // THE assertion this file exists for. If the reader were not ALS-wrapped, this would
    // return a curve of zeroes rather than throw — the silent shape. A non-zero verified
    // count proves the policy and the read agree.
    const points = await runWithMemexId(memexId, async () => acsOverTime(memexId));
    const verified = points.reduce((n, p) => n + p.verified, 0);
    expect(verified).toBeGreaterThan(0);
  });

  it("another tenant sees none of it", async () => {
    tagAc(AC_TENANCY);
    tagAc(AC_DEC7);
    // Reads under a foreign tenant rather than with NO context: with app.memex_id unset the
    // policy's ::uuid cast can be evaluated before the guarding IS NOT NULL conjunct — SQL
    // does not promise AND short-circuits — and the query errors instead of returning empty.
    // Erroring still "proves" the policy is attached, but by a route indistinguishable from a
    // dozen other faults. A foreign tenant exercises the predicate the way production does.
    const other = "00000000-0000-4000-8000-000000000042";
    const leaked = await runWithMemexId(other, async () =>
      db
        .select({ subjectRef: acFirstVerified.subjectRef })
        .from(acFirstVerified)
        .where(eq(acFirstVerified.subjectRef, acRef)),
    );
    expect(leaked).toEqual([]);
  });

  it("keeps memex_id NULLABLE, so a ref with no surviving summary row kept its date", async () => {
    tagAc(AC_TENANCY);
    tagAc(AC_DEC7);
    // ac_first_verified exists BECAUSE retention destroyed the first-green date once
    // already. Migration 0136 backfilled memex_id from test_event_latest — but a ref whose
    // summary row is gone (a discontinued AC, a deleted Spec) has nothing to resolve from.
    // Making the column NOT NULL would have forced those rows to be deleted or the
    // migration to fail, and deleting them would be the same loss happening a second time,
    // this time on purpose.
    //
    // Under the policy a NULL matches no tenant, so the row is invisible to the product and
    // visible to the owner role; the writer heals it on that ref's next emission. This
    // asserts the column stayed nullable — the schema fact the choice rests on.
    const [col] = (await db.execute(sql`
      SELECT is_nullable::text AS is_nullable
      FROM information_schema.columns
      WHERE table_name = 'ac_first_verified' AND column_name = 'memex_id'
    `)) as unknown as Array<{ is_nullable: string }>;
    expect(col.is_nullable).toBe("YES");
  });

  it("the policy is ENABLEd and NOT FORCEd", async () => {
    tagAc(AC_TENANCY);
    tagAc(AC_DEC7);
    // std-36: FORCE would apply RLS to the table OWNER too, and on Cloud SQL the deploy role
    // is not a superuser and lacks BYPASSRLS — every migration against this table would then
    // be filtered to nothing. 0081 shipped FORCE and 0093 had to undo it.
    const [row] = (await db.execute(sql`
      SELECT relrowsecurity AS enabled, relforcerowsecurity AS forced
        FROM pg_class WHERE relname = 'ac_first_verified'
    `)) as unknown as Array<{ enabled: boolean; forced: boolean }>;
    expect(row.enabled).toBe(true);
    expect(row.forced).toBe(false);
  });
});
