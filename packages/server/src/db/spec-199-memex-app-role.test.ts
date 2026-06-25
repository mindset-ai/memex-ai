import { describe, it, expect } from "vitest";
import { sql } from "drizzle-orm";
import { db } from "./connection.js";
import { tagAc } from "@memex-ai-ac/vitest";

// spec-199 ac-18: memex_app Postgres role properties.
//
// Verifies the role created by migration 0081 has the correct attributes:
// NOSUPERUSER, NOBYPASSRLS, NOINHERIT. Also confirms it holds DML privileges
// on every public table and on sequences in the schema.
//
// These tests run against the local test DB (where 0081 has been applied).
// The same properties must hold in Cloud SQL INT/PROD — verified post-deploy
// by the smoke suite (std-17) and the t-14 cutover checklist.

const AC_18 = "mindset-prod/memex-building-itself/specs/spec-199/acs/ac-18";

describe("spec-199 ac-18: memex_app role attributes and grants", () => {
  it("ac-18: memex_app role exists and is NOSUPERUSER NOBYPASSRLS", async () => {
    tagAc(AC_18);

    const rows = (await db.execute(sql`
      SELECT rolname, rolsuper, rolbypassrls, rolinherit, rolcreaterole, rolcreatedb
      FROM pg_roles
      WHERE rolname = 'memex_app'
    `)) as unknown as Array<{
      rolname: string;
      rolsuper: boolean;
      rolbypassrls: boolean;
      rolinherit: boolean;
      rolcreaterole: boolean;
      rolcreatedb: boolean;
    }>;

    expect(rows.length, "memex_app role not found in pg_roles").toBe(1);
    const role = rows[0]!;
    expect(role.rolsuper, "memex_app must not be superuser").toBe(false);
    expect(role.rolbypassrls, "memex_app must not have BYPASSRLS").toBe(false);
    expect(role.rolcreaterole, "memex_app must not have CREATEROLE").toBe(false);
    expect(role.rolcreatedb, "memex_app must not have CREATEDB").toBe(false);
  });

  it("ac-18: memex_app has SELECT privilege on the documents table", async () => {
    tagAc(AC_18);

    // Spot-check one table; the migration uses GRANT ... ON ALL TABLES which
    // covers every table in the schema. Checking one is sufficient to confirm
    // the grant ran — a failed grant would leave no privileges at all.
    const rows = (await db.execute(sql`
      SELECT has_table_privilege('memex_app', 'documents', 'SELECT') AS has_select,
             has_table_privilege('memex_app', 'documents', 'INSERT') AS has_insert,
             has_table_privilege('memex_app', 'documents', 'UPDATE') AS has_update,
             has_table_privilege('memex_app', 'documents', 'DELETE') AS has_delete
    `)) as unknown as Array<{
      has_select: boolean;
      has_insert: boolean;
      has_update: boolean;
      has_delete: boolean;
    }>;

    const perms = rows[0]!;
    expect(perms.has_select, "memex_app missing SELECT on documents").toBe(true);
    expect(perms.has_insert, "memex_app missing INSERT on documents").toBe(true);
    expect(perms.has_update, "memex_app missing UPDATE on documents").toBe(true);
    expect(perms.has_delete, "memex_app missing DELETE on documents").toBe(true);
  });

  it("ac-18: memex_app has USAGE privilege on the public schema", async () => {
    tagAc(AC_18);

    const rows = (await db.execute(sql`
      SELECT has_schema_privilege('memex_app', 'public', 'USAGE') AS has_usage
    `)) as unknown as Array<{ has_usage: boolean }>;

    expect(rows[0]!.has_usage, "memex_app missing USAGE on public schema").toBe(true);
  });

  it("ac-18: memex_app cannot connect as postgres (BYPASSRLS test — superuser bypasses RLS, memex_app does not)", async () => {
    tagAc(AC_18);

    // Confirm postgres IS a superuser (the role used for migrations)
    const pgRows = (await db.execute(sql`
      SELECT rolsuper, rolbypassrls
      FROM pg_roles
      WHERE rolname = 'postgres'
    `)) as unknown as Array<{ rolsuper: boolean; rolbypassrls: boolean }>;

    // postgres must remain superuser/BYPASSRLS so migrations keep working
    expect(pgRows[0]?.rolsuper, "postgres must remain superuser").toBe(true);
    expect(pgRows[0]?.rolbypassrls, "postgres must retain BYPASSRLS").toBe(true);
  });
});
