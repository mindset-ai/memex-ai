import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, inArray, sql } from "drizzle-orm";
import postgres from "postgres";
import { db } from "./connection.js";
import { documents, memexes, namespaces } from "./schema.js";
import { tagAc } from "@memex-ai-ac/vitest";

// spec-199 ac-16: RLS tenant isolation via restricted role.
//
// These tests prove that the Phase 2 RLS policies (migration 0081) enforce
// tenant isolation at the database level — not merely at the application layer.
// They open a second postgres-js connection AS a non-superuser, non-BYPASSRLS
// role and verify:
//   - SELECT without GUC returns 0 rows (policy USING blocks every row)
//   - SELECT with correct GUC returns only the matching tenant's rows
//   - SELECT with wrong GUC hides the neighbour tenant's rows
//   - INSERT with GUC set to tenant A but row.memex_id = tenant B is rejected
//
// Why a separate connection?
//   The `db` singleton connects as `postgres` (superuser), which has BYPASSRLS
//   and would pass through every policy. We need a role with NOSUPERUSER and
//   NOBYPASSRLS to see the policies in action. The restricted role is created
//   fresh in beforeAll and dropped in afterAll so the test is self-contained.

const AC_15 = "mindset-prod/memex-building-itself/specs/spec-199/acs/ac-15";
const AC_16 = "mindset-prod/memex-building-itself/specs/spec-199/acs/ac-16";
const RLS_ROLE = "memex_rls_tester";
const RLS_PASS = "memex_rls_test_only";

describe("spec-199 ac-16: RLS tenant isolation", () => {
  let restrictedSql: postgres.Sql;
  let memexAId: string;
  let memexBId: string;

  beforeAll(async () => {
    // Drop owned objects first so DROP ROLE won't complain about privileges,
    // then recreate cleanly so reruns in the same DB don't hit conflicts.
    await db.execute(sql.raw(`DROP OWNED BY ${RLS_ROLE} CASCADE`)).catch(() => {});
    await db.execute(sql.raw(`DROP ROLE IF EXISTS ${RLS_ROLE}`));
    await db.execute(
      sql.raw(
        `CREATE ROLE ${RLS_ROLE} LOGIN PASSWORD '${RLS_PASS}'` +
          ` NOSUPERUSER NOINHERIT NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`,
      ),
    );
    await db.execute(sql.raw(`GRANT USAGE ON SCHEMA public TO ${RLS_ROLE}`));
    await db.execute(
      sql.raw(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${RLS_ROLE}`),
    );
    await db.execute(
      sql.raw(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${RLS_ROLE}`),
    );

    // Seed two namespaces + memexes directly as superuser (bypasses RLS;
    // ALS context is never set in test scope so the rlsClient proxy falls through)
    const [nsA] = await db
      .insert(namespaces)
      .values({ slug: "rls-test-ns-a", kind: "org" })
      .returning({ id: namespaces.id });
    const [nsB] = await db
      .insert(namespaces)
      .values({ slug: "rls-test-ns-b", kind: "org" })
      .returning({ id: namespaces.id });

    const [mxA] = await db
      .insert(memexes)
      .values({ namespaceId: nsA!.id, slug: "rls-mx-a", name: "RLS Memex A" })
      .returning({ id: memexes.id });
    const [mxB] = await db
      .insert(memexes)
      .values({ namespaceId: nsB!.id, slug: "rls-mx-b", name: "RLS Memex B" })
      .returning({ id: memexes.id });

    memexAId = mxA!.id;
    memexBId = mxB!.id;

    await db.insert(documents).values({
      memexId: memexAId,
      handle: "rls-doc-a",
      title: "RLS Test Doc A",
      docType: "document",
    });
    await db.insert(documents).values({
      memexId: memexBId,
      handle: "rls-doc-b",
      title: "RLS Test Doc B",
      docType: "document",
    });

    const dbUrl = new URL(
      process.env.DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5432/memex",
    );
    dbUrl.username = RLS_ROLE;
    dbUrl.password = RLS_PASS;
    restrictedSql = postgres(dbUrl.toString(), { max: 1 });
  });

  afterAll(async () => {
    await restrictedSql?.end({ timeout: 5 });
    await db.execute(sql.raw(`DROP OWNED BY ${RLS_ROLE} CASCADE`)).catch(() => {});
    await db.execute(sql.raw(`DROP ROLE IF EXISTS ${RLS_ROLE}`));
    // Clean up seed data so the namespace owner-XOR invariant check in
    // migration-smoke.api.test.ts passes when it runs in the same worker DB.
    // Our namespaces are kind='org' without owner_org_id (test-only shortcut)
    // which violates the invariant. Delete in FK order.
    const memexIds = [memexAId, memexBId].filter(Boolean);
    if (memexIds.length) {
      await db.delete(documents).where(inArray(documents.memexId, memexIds)).catch(() => {});
      await db.delete(memexes).where(inArray(memexes.id, memexIds)).catch(() => {});
    }
    await db
      .delete(namespaces)
      .where(inArray(namespaces.slug, ["rls-test-ns-a", "rls-test-ns-b"]))
      .catch(() => {});
  });

  it("ac-16: no GUC → restricted role sees 0 rows in documents", async () => {
    tagAc(AC_16);

    // No set_config call — policy USING clause evaluates to FALSE for every row
    const rows = await restrictedSql`SELECT id FROM documents LIMIT 10`;
    expect(rows).toHaveLength(0);
  });

  it("ac-16: correct GUC → only matching tenant's rows are visible", async () => {
    tagAc(AC_16);

    const rows = (await restrictedSql.begin(async (tx) => {
      await tx.unsafe("SELECT set_config('app.memex_id', $1, true)", [memexAId]);
      return tx.unsafe(
        "SELECT id, memex_id::text AS memex_id FROM documents WHERE TRUE",
      );
    })) as Array<{ id: string; memex_id: string }>;

    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.memex_id).toBe(memexAId);
    }
  });

  it("ac-16: wrong GUC → neighbour tenant rows are hidden", async () => {
    tagAc(AC_16);

    // GUC = memexA, but memexB's rows must not appear
    const rows = await restrictedSql.begin(async (tx) => {
      await tx.unsafe("SELECT set_config('app.memex_id', $1, true)", [memexAId]);
      return tx.unsafe("SELECT id FROM documents WHERE memex_id = $1", [memexBId]);
    });

    expect(rows).toHaveLength(0);
  });

  it("ac-16: cross-tenant INSERT is rejected by WITH CHECK", async () => {
    tagAc(AC_16);

    // GUC = memexA, INSERT row for memexB → WITH CHECK violation
    await expect(
      restrictedSql.begin(async (tx) => {
        await tx.unsafe("SELECT set_config('app.memex_id', $1, true)", [memexAId]);
        return tx.unsafe(
          "INSERT INTO documents (memex_id, handle, title, doc_type, status) VALUES ($1, $2, $3, $4, $5)",
          [memexBId, "rls-cross-tenant", "Cross-tenant bad insert", "document", "draft"],
        );
      }),
    ).rejects.toThrow();
  });

  it("ac-16: RLS is enabled but NOT forced on all 13 tenant tables (owner-bypass posture, spec-257 dec-1)", async () => {
    tagAc(AC_15);
    tagAc(AC_16);

    // memex_emission_keys is deliberately absent: it is an identity-
    // establishment table (verifyEmissionKey runs before ALS context exists)
    // and was excluded from RLS by migration 0087 after the 2026-06-10
    // emission outage. See 0087_emission_keys_rls_exclusion.sql and
    // __regression__/emission-key-contextless-verify.regression.test.ts.
    //
    // Posture: RLS is ENABLED (relrowsecurity=t) but NOT FORCED
    // (relforcerowsecurity=f) — migration 0091 dropped FORCE per spec-257 dec-1.
    // FORCE only affects the table OWNER; on Cloud SQL the deploy/migration role
    // is `postgres` (the owner, NOBYPASSRLS), so FORCE filtered every contextless
    // migration/deploy-script query to zero rows (the 2026-06-10 emission and
    // 2026-06-11 What's New outages). NO FORCE lets the owner bypass while the
    // non-owner runtime role `memex_app` stays subject to RLS — verified by the
    // memex_app SET LOCAL ROLE test below, which still sees 0 rows without a GUC.

    // pg_class has relrowsecurity + relforcerowsecurity (pg_tables lacks the latter)
    const rows = (await db.execute(sql`
      SELECT c.relname AS tablename,
             c.relrowsecurity AS rowsecurity,
             c.relforcerowsecurity AS forcerowsecurity
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public'
        AND c.relkind = 'r'
        AND c.relname IN (
          'documents', 'standard_clauses', 'clause_refs', 'doc_comments',
          'decisions', 'tasks', 'acs', 'issues', 'doc_members', 'doc_assignees',
          'tags', 'document_tags', 'repos'
        )
      ORDER BY c.relname
    `)) as unknown as Array<{
      tablename: string;
      rowsecurity: boolean;
      forcerowsecurity: boolean;
    }>;

    const expected = [
      "acs", "clause_refs", "decisions", "doc_assignees", "doc_comments",
      "doc_members", "document_tags", "documents", "issues",
      "repos", "standard_clauses", "tags", "tasks",
    ];

    expect(rows.length, "table count mismatch").toBe(expected.length);
    const byTable = new Map(rows.map((r) => [r.tablename, r]));
    for (const table of expected) {
      const row = byTable.get(table);
      expect(row, `${table}: not found in pg_class`).toBeDefined();
      expect(row!.rowsecurity, `${table}: rowsecurity not enabled`).toBe(true);
      expect(
        row!.forcerowsecurity,
        `${table}: FORCE must be OFF (owner-bypass posture, spec-257 dec-1 / migration 0091)`,
      ).toBe(false);
    }
  });

  it("ac-16: memex_app role without GUC sees 0 rows (SET LOCAL ROLE production path)", async () => {
    tagAc(AC_15);
    tagAc(AC_16);

    // Switch to memex_app within a transaction using SET LOCAL ROLE. memex_app
    // is a NON-OWNER role (postgres owns these tables) with NOBYPASSRLS, so
    // ENABLE ROW LEVEL SECURITY alone subjects it to the policies — FORCE is NOT
    // needed (FORCE only governs the table OWNER, which is why 0091 could drop it
    // without weakening runtime isolation, spec-257 dec-1). With no app.memex_id
    // GUC set, the USING clause blocks every row. This is the production runtime
    // path (DATABASE_URL = memex_app since t-14).
    const dbUrl =
      process.env.DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5432/memex";
    const superSql = postgres(dbUrl, { max: 1 });
    try {
      const rows = await superSql.begin(async (tx) => {
        await tx.unsafe("SET LOCAL ROLE memex_app");
        return tx.unsafe("SELECT id FROM documents LIMIT 10");
      });
      expect(rows).toHaveLength(0);
    } finally {
      await superSql.end({ timeout: 5 });
    }
  });

  it("ac-16: all 13 tables have the memex_isolation policy covering ALL commands", async () => {
    tagAc(AC_15);
    tagAc(AC_16);

    // memex_emission_keys excluded by migration 0087 (see the 13-table test above).
    const rows = (await db.execute(sql`
      SELECT tablename, policyname, cmd
      FROM pg_policies
      WHERE schemaname = 'public'
        AND tablename IN (
          'documents', 'standard_clauses', 'clause_refs', 'doc_comments',
          'decisions', 'tasks', 'acs', 'issues', 'doc_members', 'doc_assignees',
          'tags', 'document_tags', 'repos'
        )
        AND policyname = tablename || '_memex_isolation'
      ORDER BY tablename
    `)) as unknown as Array<{
      tablename: string;
      policyname: string;
      cmd: string;
    }>;

    expect(rows.length, "policy count mismatch — some tables are missing their policy").toBe(13);
    for (const row of rows) {
      expect(row.cmd, `${row.tablename}: policy should cover ALL commands`).toBe("ALL");
    }
  });
});
