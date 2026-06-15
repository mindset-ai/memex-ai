import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, inArray, sql } from "drizzle-orm";
import postgres from "postgres";
import { db } from "./connection.js";
import { memexes, namespaces, qaReportViews, users } from "./schema.js";
import { tagAc } from "@memex-ai-ac/vitest";

// spec-260 t-1: the qa_report_views per-user read-state marker (dec-6) — table shape +
// upsert (ac-21) and the memex_isolation RLS policy (ac-23, the cross-tenant 404
// guarantee at the DB level, std-7).
//
// The RLS half mirrors spec-199-rls-schema.test.ts: the `db` singleton connects as
// `postgres` (BYPASSRLS), so a second connection AS a NOSUPERUSER/NOBYPASSRLS role is
// opened to see the policy bite. Per-user scoping (a user only ever touches their OWN
// marker) is enforced in the service layer, which always operates on the authenticated
// user's row; RLS here provides the tenant boundary.

const AC_21 = "mindset-prod/memex-building-itself/specs/spec-260/acs/ac-21";
const AC_23 = "mindset-prod/memex-building-itself/specs/spec-260/acs/ac-23";
const RLS_ROLE = "qa_report_views_rls_tester";
const RLS_PASS = "qa_report_views_rls_test_only";

describe("spec-260: qa_report_views marker + RLS isolation", () => {
  let restrictedSql: postgres.Sql;
  let memexAId: string;
  let memexBId: string;
  let userId: string;

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

    // Seed two memexes (distinct tenants) + a user. Superuser path bypasses RLS.
    const [nsA] = await db
      .insert(namespaces)
      .values({ slug: "qrv-test-ns-a", kind: "org" })
      .returning({ id: namespaces.id });
    const [nsB] = await db
      .insert(namespaces)
      .values({ slug: "qrv-test-ns-b", kind: "org" })
      .returning({ id: namespaces.id });
    const [mxA] = await db
      .insert(memexes)
      .values({ namespaceId: nsA!.id, slug: "qrv-mx-a", name: "QRV Memex A" })
      .returning({ id: memexes.id });
    const [mxB] = await db
      .insert(memexes)
      .values({ namespaceId: nsB!.id, slug: "qrv-mx-b", name: "QRV Memex B" })
      .returning({ id: memexes.id });
    const [u] = await db
      .insert(users)
      .values({ email: "qrv-test-user@example.com" })
      .returning({ id: users.id });

    memexAId = mxA!.id;
    memexBId = mxB!.id;
    userId = u!.id;

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
    const memexIds = [memexAId, memexBId].filter(Boolean);
    if (memexIds.length) {
      await db.delete(qaReportViews).where(inArray(qaReportViews.memexId, memexIds)).catch(() => {});
      await db.delete(memexes).where(inArray(memexes.id, memexIds)).catch(() => {});
    }
    if (userId) await db.delete(users).where(eq(users.id, userId)).catch(() => {});
    await db
      .delete(namespaces)
      .where(inArray(namespaces.slug, ["qrv-test-ns-a", "qrv-test-ns-b"]))
      .catch(() => {});
  });

  it("ac-21: the marker is keyed (user_id, memex_id) and an upsert moves last_viewed_at without adding a row", async () => {
    tagAc(AC_21);

    const t0 = new Date("2026-01-01T00:00:00.000Z");
    await db.insert(qaReportViews).values({ userId, memexId: memexAId, lastViewedAt: t0 });

    // Re-viewing upserts onto the composite PK: same (user, memex) → updated timestamp,
    // still exactly one row (the reset-on-view mechanism the endpoint relies on).
    const t1 = new Date("2026-02-02T00:00:00.000Z");
    await db
      .insert(qaReportViews)
      .values({ userId, memexId: memexAId, lastViewedAt: t1 })
      .onConflictDoUpdate({
        target: [qaReportViews.userId, qaReportViews.memexId],
        set: { lastViewedAt: t1 },
      });

    const rows = await db
      .select()
      .from(qaReportViews)
      .where(and(eq(qaReportViews.userId, userId), eq(qaReportViews.memexId, memexAId)));

    expect(rows).toHaveLength(1);
    expect(rows[0]!.lastViewedAt.toISOString()).toBe(t1.toISOString());
  });

  it("ac-23: no GUC → restricted role sees 0 marker rows", async () => {
    tagAc(AC_23);

    const rows = await restrictedSql`SELECT user_id FROM qa_report_views LIMIT 10`;
    expect(rows).toHaveLength(0);
  });

  it("ac-23: correct GUC → only the current memex's marker is visible", async () => {
    tagAc(AC_23);

    // Seed a marker in each memex (superuser bypass), then read as the restricted role.
    await db
      .insert(qaReportViews)
      .values({ userId, memexId: memexBId, lastViewedAt: new Date("2026-03-03T00:00:00.000Z") })
      .onConflictDoNothing();

    const rows = (await restrictedSql.begin(async (tx) => {
      await tx.unsafe("SELECT set_config('app.memex_id', $1, true)", [memexAId]);
      return tx.unsafe("SELECT memex_id::text AS memex_id FROM qa_report_views WHERE TRUE");
    })) as Array<{ memex_id: string }>;

    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) expect(row.memex_id).toBe(memexAId);
  });

  it("ac-23: cross-tenant INSERT is rejected by WITH CHECK", async () => {
    tagAc(AC_23);

    // GUC = memexA, but the row names memexB → WITH CHECK violation.
    await expect(
      restrictedSql.begin(async (tx) => {
        await tx.unsafe("SELECT set_config('app.memex_id', $1, true)", [memexAId]);
        return tx.unsafe(
          "INSERT INTO qa_report_views (user_id, memex_id, last_viewed_at) VALUES ($1, $2, now())",
          [userId, memexBId],
        );
      }),
    ).rejects.toThrow();
  });
});
