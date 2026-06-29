import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, inArray, sql } from "drizzle-orm";
import postgres from "postgres";
import { db } from "../db/connection.js";
import { namespaces, orgs, memexes, documents } from "../db/schema.js";

// Regression guard for the spec-checkout phone-home RLS trap (spec-371).
//
// POST /api/spec-checkout authenticates a HOOK KEY (an RLS-excluded table, like
// emission keys) and resolves the tenant from the body ref — both run with NO
// app.memex_id context. It then must READ the `documents` table to resolve the
// claimed spec's doc id. `documents` has ROW LEVEL SECURITY enabled (std-36:
// ENABLE, never FORCE): the policy filters every row unless app.memex_id is set.
// ENABLE (not FORCE) means the table OWNER bypasses — but the Cloud Run runtime
// role `memex_app` is NOT the owner, so the policy applies to it in full.
//
// The trap (identical to the 2026-06-10 emission outage, see
// emission-key-contextless-verify.regression.test.ts): a contextless read passes
// locally because the dev `postgres` role is a SUPERUSER that bypasses RLS, then
// returns ZERO rows the moment Cloud Run connects as the non-super `memex_app`
// role — so on int every phone-home resolved `spec_not_found` and recorded nothing.
//
// The fix wraps the read (and the record write) in runWithMemexId(memexId), which
// sets app.memex_id for the policy. These tests pin the invariant the way the
// emission test does: SET LOCAL ROLE memex_app inside a transaction drops the
// superuser bypass, so the connection sees exactly what the runtime role sees.

const NS_SLUG = "phonehome-rls-regress-ns";
const SPEC_HANDLE = "spec-rls-1";

describe("regression: spec-checkout phone-home read needs app.memex_id under RLS", () => {
  let nsId: string;
  let orgId: string;
  let memexId: string;
  let docId: string;

  beforeAll(async () => {
    // Setup runs as the superuser (global `db`) — bypasses RLS to seed the rows.
    const [ns] = await db
      .insert(namespaces)
      .values({ slug: NS_SLUG, kind: "org" })
      .returning({ id: namespaces.id });
    nsId = ns!.id;
    // Own the namespace by an org so it satisfies the owner-XOR invariant — otherwise a
    // kind='org' namespace with a NULL owner_org_id trips migration-smoke's global scan
    // when these tests share a worker DB clone (std-37, parallel-fixture isolation).
    const [org] = await db
      .insert(orgs)
      .values({ namespaceId: nsId, name: "Phonehome RLS Regress Org" })
      .returning({ id: orgs.id });
    orgId = org!.id;
    await db.update(namespaces).set({ ownerOrgId: orgId }).where(eq(namespaces.id, nsId));
    const [mx] = await db
      .insert(memexes)
      .values({ namespaceId: nsId, slug: "phonehome-rls-regress-mx", name: "Phonehome RLS Regress" })
      .returning({ id: memexes.id });
    memexId = mx!.id;
    const [doc] = await db
      .insert(documents)
      .values({ memexId, handle: SPEC_HANDLE, title: "RLS Regress Spec", docType: "spec" })
      .returning({ id: documents.id });
    docId = doc!.id;
  });

  afterAll(async () => {
    // FK order: documents → memexes → break the namespace↔org cycle (null the
    // namespace's owner_org_id) → org → namespace.
    if (memexId) {
      await db.delete(documents).where(eq(documents.memexId, memexId)).catch(() => {});
      await db.delete(memexes).where(inArray(memexes.id, [memexId])).catch(() => {});
    }
    if (nsId) {
      await db.update(namespaces).set({ ownerOrgId: null }).where(eq(namespaces.id, nsId)).catch(() => {});
    }
    if (orgId) {
      await db.delete(orgs).where(eq(orgs.id, orgId)).catch(() => {});
    }
    await db.delete(namespaces).where(eq(namespaces.slug, NS_SLUG)).catch(() => {});
  });

  it("documents has RLS ENABLED — the trap that filters the non-owner runtime role", async () => {
    const rows = (await db.execute(sql`
      SELECT c.relrowsecurity AS rowsecurity,
             c.relforcerowsecurity AS forcerowsecurity
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname = 'documents'
    `)) as unknown as Array<{ rowsecurity: boolean; forcerowsecurity: boolean }>;
    expect(rows).toHaveLength(1);
    // ENABLE is what subjects the non-owner memex_app role to the policy.
    expect(rows[0]!.rowsecurity).toBe(true);
    // NOT forced — std-36 (ENABLE, never FORCE). FORCE isn't needed for the trap:
    // memex_app is a non-owner role, so plain ENABLE already filters it. The owner /
    // superuser bypass that ENABLE permits is exactly what masks the bug locally.
    expect(rows[0]!.forcerowsecurity).toBe(false);
  });

  it("as memex_app with NO app.memex_id, the spec lookup returns ZERO rows (the bug)", async () => {
    const dbUrl =
      process.env.DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5432/memex";
    const roleSql = postgres(dbUrl, { max: 1 });
    try {
      // The exact lookup POST /api/spec-checkout issues, as the Cloud Run runtime
      // role with no context. Pre-fix this returned 0 rows → spec_not_found → the
      // phone-home recorded nothing on int.
      const rows = await roleSql.begin(async (tx) => {
        await tx.unsafe("SET LOCAL ROLE memex_app");
        return tx.unsafe(
          "SELECT id FROM documents WHERE memex_id = $1 AND handle = $2 AND doc_type = 'spec'",
          [memexId, SPEC_HANDLE],
        );
      });
      expect(rows).toHaveLength(0);
    } finally {
      await roleSql.end({ timeout: 5 });
    }
  });

  it("as memex_app WITH app.memex_id set (what runWithMemexId does), the spec is found (the fix)", async () => {
    const dbUrl =
      process.env.DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5432/memex";
    const roleSql = postgres(dbUrl, { max: 1 });
    try {
      const rows = await roleSql.begin(async (tx) => {
        await tx.unsafe("SET LOCAL ROLE memex_app");
        // runWithMemexId(memexId) issues exactly this set_config before the read.
        await tx.unsafe("SELECT set_config('app.memex_id', $1, true)", [memexId]);
        return tx.unsafe(
          "SELECT id FROM documents WHERE memex_id = $1 AND handle = $2 AND doc_type = 'spec'",
          [memexId, SPEC_HANDLE],
        );
      });
      expect(rows).toHaveLength(1);
      expect((rows[0] as { id: string }).id).toBe(docId);
    } finally {
      await roleSql.end({ timeout: 5 });
    }
  });
});
