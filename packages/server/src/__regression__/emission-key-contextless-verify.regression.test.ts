import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, inArray, sql } from "drizzle-orm";
import postgres from "postgres";
import { db } from "../db/connection.js";
import { memexEmissionKeys, memexes, namespaces } from "../db/schema.js";
import {
  generateRawKey,
  hashKey,
  displayPrefix,
  verifyEmissionKey,
} from "../services/emission-keys.js";

// Regression guard for the 2026-06-10 emission outage.
//
// memex_emission_keys is an identity-ESTABLISHMENT table: verifyEmissionKey()
// is the query that AUTHENTICATES POST /api/test-events, so it necessarily
// runs before any ALS tenant context exists: the key lookup is what resolves
// the tenant. Migration 0081 (spec-199 Phase 2) put a memex_id RLS policy on
// it anyway; the policy lay dormant while the runtime connected as `postgres`
// (BYPASSRLS) and detonated the moment t-14 cut DATABASE_URL over to the
// `memex_app` role: with no app.memex_id GUC set at verify time the policy
// filtered every row, verifyEmissionKey() hit its null branch, and every key
// (UI-minted, freshly-minted, CI's) got 401. Platform-wide AC emission was
// down from 09:25:34Z until migration 0087 excluded the table from RLS.
//
// These tests pin the invariant "key verification must work before tenant
// context exists" against any future RLS sweep re-adding this table. The
// production path is simulated the same way as spec-199-rls-schema.test.ts:
// SET LOCAL ROLE memex_app inside a transaction drops BYPASSRLS, so the
// connection sees exactly what Cloud Run's runtime role sees.

const NS_SLUG = "emission-rls-regress-ns";

describe("regression: emission-key verification needs no tenant context (0087)", () => {
  let memexId: string;
  let rawKey: string;

  beforeAll(async () => {
    const [ns] = await db
      .insert(namespaces)
      .values({ slug: NS_SLUG, kind: "org" })
      .returning({ id: namespaces.id });
    const [mx] = await db
      .insert(memexes)
      .values({ namespaceId: ns!.id, slug: "emission-rls-regress-mx", name: "Emission RLS Regress" })
      .returning({ id: memexes.id });
    memexId = mx!.id;

    rawKey = generateRawKey();
    await db.insert(memexEmissionKeys).values({
      memexId,
      name: "contextless-verify regression",
      hashedKey: hashKey(rawKey),
      prefix: displayPrefix(rawKey),
    });
  });

  afterAll(async () => {
    // Clean up in FK order; the test namespace is kind='org' without
    // owner_org_id (test-only shortcut), which would otherwise trip the
    // owner-XOR invariant check in migration-smoke.api.test.ts.
    if (memexId) {
      await db
        .delete(memexEmissionKeys)
        .where(eq(memexEmissionKeys.memexId, memexId))
        .catch(() => {});
      await db.delete(memexes).where(inArray(memexes.id, [memexId])).catch(() => {});
    }
    await db.delete(namespaces).where(eq(namespaces.slug, NS_SLUG)).catch(() => {});
  });

  it("memex_emission_keys has RLS disabled (migration 0087 applied)", async () => {
    const rows = (await db.execute(sql`
      SELECT c.relrowsecurity AS rowsecurity,
             c.relforcerowsecurity AS forcerowsecurity
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname = 'memex_emission_keys'
    `)) as unknown as Array<{ rowsecurity: boolean; forcerowsecurity: boolean }>;

    expect(rows).toHaveLength(1);
    expect(rows[0]!.rowsecurity, "RLS re-enabled on memex_emission_keys: this re-breaks /api/test-events auth").toBe(false);
    expect(rows[0]!.forcerowsecurity).toBe(false);
  });

  it("memex_app role with NO GUC finds the key row (the verifyEmissionKey production path)", async () => {
    const dbUrl =
      process.env.DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5432/memex";
    const superSql = postgres(dbUrl, { max: 1 });
    try {
      // The exact lookup verifyEmissionKey() issues, run as the Cloud Run
      // runtime role with no app.memex_id set. Before 0087 this returned
      // 0 rows and every emission 401'd.
      const rows = await superSql.begin(async (tx) => {
        await tx.unsafe("SET LOCAL ROLE memex_app");
        return tx.unsafe(
          "SELECT id FROM memex_emission_keys WHERE hashed_key = $1 AND revoked_at IS NULL",
          [hashKey(rawKey)],
        );
      });
      expect(rows).toHaveLength(1);
    } finally {
      await superSql.end({ timeout: 5 });
    }
  });

  it("verifyEmissionKey() resolves the key end to end", async () => {
    const row = await verifyEmissionKey(rawKey);
    expect(row).not.toBeNull();
    expect(row!.memexId).toBe(memexId);
  });
});
