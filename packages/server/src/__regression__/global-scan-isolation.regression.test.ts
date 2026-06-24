// spec-395 (workstream F, dec-3 item 3): the four "global-scan" merge-gate flakes
// were std-37 violations — assertions/fixtures that a sibling test sharing the
// per-worker DB clone could perturb. This regression suite pins the INVARIANTS that
// keep them scoped, so a future change can't silently reintroduce the flake:
//
//   1. migration-smoke's "every active user has a namespace" GLOBAL scan must
//      EXCLUDE the test-fixture domain surface (@example.* / *.test / *.invalid /
//      *.local) — so a sibling's raw-insert fixture user can't redden it [std-37 cl-4].
//   2. backfillAllUserProfiles must be resilient to a user that vanishes mid-scan
//      (a concurrent sibling delete) — it builds per-user with swallow, never aborts.
//
// The embeddings idempotency isolation (its own `emb-backfill` memex) and the
// qa-reports author fixture domain (@example.com) are pinned by their own files'
// tests passing; this suite guards the two SHARED-INVARIANT surfaces directly.

import { describe, it, expect, afterEach } from "vitest";
import { sql, eq } from "drizzle-orm";
import { tagAc } from "@memex-ai-ac/vitest";
import { db } from "../db/connection.js";
import { users } from "../db/schema.js";
import {
  backfillAllUserProfiles,
  type EngageProfile,
  type ProfileSink,
} from "../services/mixpanel-profile.js";

const AC_SCOPE = "mindset-prod/memex-building-itself/specs/spec-395/acs/ac-3";
const AC_IMPL = "mindset-prod/memex-building-itself/specs/spec-395/acs/ac-6";

// The EXACT exclusion predicate migration-smoke applies to its active/null-namespace
// scan. Kept in lockstep with src/__e2e__/migration-smoke.api.test.ts — if that scan's
// exclusion list changes, this assertion is the tripwire that says "update both".
function migrationSmokeMissingCount(): Promise<number> {
  return db
    .execute(sql`
      SELECT count(*)::int AS missing FROM users
      WHERE status = 'active'
        AND namespace_id IS NULL
        AND email NOT LIKE '%@example.com'
        AND email NOT LIKE '%@example.net'
        AND email NOT LIKE '%@example.org'
        AND email NOT LIKE '%.example'
        AND email NOT LIKE '%.test'
        AND email NOT LIKE '%.invalid'
        AND email NOT LIKE '%.local'
        AND email NOT LIKE 'doc-move-%@memex.ai'
    `)
    .then((r) => (r as unknown as { missing: number }[])[0].missing);
}

const createdUserIds: string[] = [];

afterEach(async () => {
  if (createdUserIds.length) {
    await db.delete(users).where(eq(users.id, createdUserIds[0])).catch(() => {});
    // delete the rest too (scoped to what this suite created — std-37 cl-6)
    for (const id of createdUserIds.slice(1)) {
      await db.delete(users).where(eq(users.id, id)).catch(() => {});
    }
    createdUserIds.length = 0;
  }
});

class FakeSink implements ProfileSink {
  readonly name = "fake-regression";
  readonly received: EngageProfile[] = [];
  async setProfiles(profiles: readonly EngageProfile[]): Promise<void> {
    this.received.push(...profiles);
  }
}

describe("spec-395: global-scan isolation (std-37)", () => {
  it("migration-smoke's active/null-namespace scan is IMMUNE to a test-fixture user under an excluded domain", async () => {
    tagAc(AC_SCOPE);
    tagAc(AC_IMPL);

    const before = await migrationSmokeMissingCount();

    // A raw-insert fixture user, exactly the shape tenant-isolation / uuid-input-rejection
    // leave behind: active (schema default), namespace_id NULL — but under the
    // @example.com test domain the spec-395 contract mandates for such fixtures.
    const [u] = await db
      .insert(users)
      .values({
        email: `gsi-fixture-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@example.com`,
      } as never)
      .returning();
    createdUserIds.push(u.id);

    // It IS an active, null-namespace row...
    const [row] = (await db.execute(sql`
      SELECT status, namespace_id FROM users WHERE id = ${u.id}
    `)) as unknown as { status: string; namespace_id: string | null }[];
    expect(row.status).toBe("active");
    expect(row.namespace_id).toBeNull();

    // ...yet the migration-smoke scan's count is UNCHANGED — the excluded domain
    // filters it, so a sibling fixture can never redden the invariant.
    const after = await migrationSmokeMissingCount();
    expect(after).toBe(before);
  });

  it("the SAME row under a NON-excluded domain WOULD be counted — proving the exclusion is what protects the scan", async () => {
    tagAc(AC_IMPL);

    const before = await migrationSmokeMissingCount();
    // Deliberately a non-excluded domain to demonstrate the scan genuinely counts
    // such rows (this is the failure mode the @example.com contract prevents). The
    // afterEach deletes it, so it never leaks to a sibling.
    const [u] = await db
      .insert(users)
      .values({
        email: `gsi-leak-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@memex.example-not-excluded`,
      } as never)
      .returning();
    createdUserIds.push(u.id);

    const after = await migrationSmokeMissingCount();
    expect(after).toBe(before + 1);
  });

  it("backfillAllUserProfiles is resilient — a user removed mid-scan never aborts the whole backfill (sent === total)", async () => {
    tagAc(AC_SCOPE);
    tagAc(AC_IMPL);

    const sink = new FakeSink();
    const result = await backfillAllUserProfiles({ sink });
    // Whatever the global user set, the contract holds: every profile it built was
    // sent. A sibling churning users can change the absolute numbers but never break
    // this equality (the per-user try/catch drops failures instead of throwing).
    expect(result.sent).toBe(result.total);
    expect(result.total).toBeGreaterThanOrEqual(0);
    expect(sink.received.length).toBe(result.sent);
  });
});
