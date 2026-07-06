import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, inArray, sql } from "drizzle-orm";
import postgres from "postgres";
import { db } from "./connection.js";
import { documentVersions, docViews, documents, memexes, namespaces, users } from "./schema.js";
import { tagAc } from "@memex-ai-ac/vitest";

// spec-448 t-1: the database primitives for document versioning — RLS proof for
// the two new tables.
//
//   document_versions — a standard memex-scoped tenant table (std-36): joins the
//   `*_memex_isolation` family (RLS_TENANT_TABLES, rls-tables.ts), so the proof
//   mirrors the existing per-table precedent (spec-199-rls-schema.test.ts,
//   spec-260-qa-report-views.test.ts) — a restricted, non-owner/NOBYPASSRLS role
//   sees zero rows with no `app.memex_id` GUC, and only the matching tenant's
//   rows with the correct one.
//
//   doc_views — NOT memex-scoped (no memex_id column at all, per the spec-448
//   deliverable). It carries its OWN exclusive `doc_views_owner_isolation`
//   policy keyed on `app.user_id` (the GUC spec-303's runWithUserId already
//   sets, migration 0098) — this is a genuinely new RLS shape (existing
//   per-user tables like qa_report_views scope by memex_id and leave per-user
//   scoping to the service layer). The proof: a restricted role can read ONLY
//   the row matching the GUC's user_id, never a different user's marker on the
//   SAME doc.
//
// `db` connects as `postgres` (the table owner), which bypasses RLS (std-36:
// ENABLE, NO FORCE) — so a second connection AS a NOSUPERUSER/NOBYPASSRLS role
// is opened to see the policies actually bite. Identifiers are worker-unique
// (std-37) so this file is safe to run under vitest's per-worker parallelism.

const AC_12 = "mindset-prod/memex-building-itself/specs/spec-448/acs/ac-12";
const AC_38 = "mindset-prod/memex-building-itself/specs/spec-448/acs/ac-38";

const worker = process.env.VITEST_POOL_ID ?? "0";
const runId = `${worker}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const RLS_ROLE = `doc_ver_rls_tester_${worker}`;
const RLS_PASS = "doc_ver_rls_test_only";

describe("spec-448: document_versions + doc_views RLS isolation", () => {
  let restrictedSql: postgres.Sql;
  let memexAId: string;
  let memexBId: string;
  let docAId: string;
  let userAId: string;
  let userBId: string;

  beforeAll(async () => {
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

    // Seed two memexes (distinct tenants) + a doc in memex A + two users.
    // Superuser path bypasses RLS, so this seeding is unaffected by the policy.
    const [nsA] = await db
      .insert(namespaces)
      .values({ slug: `dvr-ns-a-${runId}`, kind: "org" })
      .returning({ id: namespaces.id });
    const [nsB] = await db
      .insert(namespaces)
      .values({ slug: `dvr-ns-b-${runId}`, kind: "org" })
      .returning({ id: namespaces.id });
    const [mxA] = await db
      .insert(memexes)
      .values({ namespaceId: nsA!.id, slug: `dvr-mx-a-${runId}`, name: "DVR Memex A" })
      .returning({ id: memexes.id });
    const [mxB] = await db
      .insert(memexes)
      .values({ namespaceId: nsB!.id, slug: `dvr-mx-b-${runId}`, name: "DVR Memex B" })
      .returning({ id: memexes.id });
    const [doc] = await db
      .insert(documents)
      .values({ memexId: mxA!.id, handle: `dvr-doc-${runId}`, title: "DVR Test Spec" })
      .returning({ id: documents.id });
    const [uA] = await db
      .insert(users)
      .values({ email: `dvr-user-a-${runId}@example.com` })
      .returning({ id: users.id });
    const [uB] = await db
      .insert(users)
      .values({ email: `dvr-user-b-${runId}@example.com` })
      .returning({ id: users.id });

    memexAId = mxA!.id;
    memexBId = mxB!.id;
    docAId = doc!.id;
    userAId = uA!.id;
    userBId = uB!.id;

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
    if (docAId) await db.delete(documents).where(eq(documents.id, docAId)).catch(() => {});
    const memexIds = [memexAId, memexBId].filter(Boolean);
    if (memexIds.length) await db.delete(memexes).where(inArray(memexes.id, memexIds)).catch(() => {});
    const userIds = [userAId, userBId].filter(Boolean);
    if (userIds.length) await db.delete(users).where(inArray(users.id, userIds)).catch(() => {});
    await db
      .delete(namespaces)
      .where(inArray(namespaces.slug, [`dvr-ns-a-${runId}`, `dvr-ns-b-${runId}`]))
      .catch(() => {});
  });

  describe("ac-12: document_versions memex_isolation", () => {
    it("no GUC → restricted role sees 0 rows", async () => {
      tagAc(AC_12);

      await db.insert(documentVersions).values({
        memexId: memexAId,
        docId: docAId,
        versionNumber: 1,
        name: "Initial snapshot",
        checksum: "checksum-1",
        snapshot: { sections: [], decisions: [], acs: [], tasks: [], issues: [], comments: [] },
      });

      const rows = await restrictedSql`SELECT id FROM document_versions LIMIT 10`;
      expect(rows).toHaveLength(0);
    });

    it("correct GUC → only the current memex's version rows are visible", async () => {
      tagAc(AC_12);

      // Seed a second snapshot in the OTHER tenant (memex B) so cross-tenant
      // leakage would show up if the policy were missing/wrong. memex B has no
      // doc, so it borrows doc A's id purely as an FK target — cross-tenant
      // FK sharing doesn't matter for what this test asserts (row visibility).
      // version_number 2 (not 1) — same doc_id as the memex-A row above, so the
      // (doc_id, version_number) UNIQUE constraint needs a distinct number; the
      // memex_id column (not doc_id) is what this test asserts isolation on.
      await db.insert(documentVersions).values({
        memexId: memexBId,
        docId: docAId,
        versionNumber: 2,
        name: "Memex B snapshot",
        checksum: "checksum-2",
        snapshot: {},
      });

      const rows = (await restrictedSql.begin(async (tx) => {
        await tx.unsafe("SELECT set_config('app.memex_id', $1, true)", [memexAId]);
        return tx.unsafe("SELECT memex_id::text AS memex_id FROM document_versions WHERE TRUE");
      })) as Array<{ memex_id: string }>;

      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) expect(row.memex_id).toBe(memexAId);
    });

    it("cross-tenant INSERT is rejected by WITH CHECK", async () => {
      tagAc(AC_12);

      await expect(
        restrictedSql.begin(async (tx) => {
          await tx.unsafe("SELECT set_config('app.memex_id', $1, true)", [memexAId]);
          return tx.unsafe(
            `INSERT INTO document_versions
              (memex_id, doc_id, version_number, name, checksum, snapshot)
             VALUES ($1, $2, 99, 'bad', 'bad-checksum', '{}')`,
            [memexBId, docAId],
          );
        }),
      ).rejects.toThrow();
    });
  });

  describe("ac-38: doc_views owner-only isolation", () => {
    it("a user only ever sees THEIR OWN marker row, never another user's on the same doc", async () => {
      tagAc(AC_38);

      const t0 = new Date("2026-01-01T00:00:00.000Z");
      const t1 = new Date("2026-02-02T00:00:00.000Z");
      await db.insert(docViews).values([
        { userId: userAId, docId: docAId, lastViewedVersion: 1, lastViewedAt: t0, channel: "rest_ui" },
        { userId: userBId, docId: docAId, lastViewedVersion: 2, lastViewedAt: t1, channel: "mcp" },
      ]);

      // No GUC → 0 rows.
      const noGucRows = await restrictedSql`SELECT user_id FROM doc_views LIMIT 10`;
      expect(noGucRows).toHaveLength(0);

      // app.user_id = userA → only userA's row, never userB's.
      const asUserA = (await restrictedSql.begin(async (tx) => {
        await tx.unsafe("SELECT set_config('app.user_id', $1, true)", [userAId]);
        return tx.unsafe("SELECT user_id::text AS user_id, last_viewed_version FROM doc_views WHERE TRUE");
      })) as Array<{ user_id: string; last_viewed_version: number }>;

      expect(asUserA.length).toBeGreaterThan(0);
      for (const row of asUserA) expect(row.user_id).toBe(userAId);
      expect(asUserA.some((r) => r.user_id === userBId)).toBe(false);

      // app.user_id = userB → only userB's row.
      const asUserB = (await restrictedSql.begin(async (tx) => {
        await tx.unsafe("SELECT set_config('app.user_id', $1, true)", [userBId]);
        return tx.unsafe("SELECT user_id::text AS user_id FROM doc_views WHERE TRUE");
      })) as Array<{ user_id: string }>;

      expect(asUserB.length).toBeGreaterThan(0);
      for (const row of asUserB) expect(row.user_id).toBe(userBId);
    });

    it("cross-user INSERT is rejected by WITH CHECK", async () => {
      tagAc(AC_38);

      await expect(
        restrictedSql.begin(async (tx) => {
          await tx.unsafe("SELECT set_config('app.user_id', $1, true)", [userAId]);
          // GUC says userA, but the row names userB → WITH CHECK violation.
          return tx.unsafe(
            `INSERT INTO doc_views (user_id, doc_id, last_viewed_version, last_viewed_at, channel)
             VALUES ($1, $2, 1, now(), 'rest_ui')`,
            [userBId, docAId],
          );
        }),
      ).rejects.toThrow();
    });
  });

  it("sanity: both tables show up in the current schema (guards against a silently-skipped migration)", async () => {
    const rows = (await db.execute(sql`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name IN ('document_versions', 'doc_views')
      ORDER BY table_name
    `)) as unknown as Array<{ table_name: string }>;
    expect(rows.map((r) => r.table_name)).toEqual(["doc_views", "document_versions"]);
  });
});
