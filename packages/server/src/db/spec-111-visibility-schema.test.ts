import { describe, it, expect } from "vitest";
import { sql } from "drizzle-orm";
import { db } from "./connection.js";
import { tagAc } from "@memex-ai-ac/vitest";

// spec-111 t-1 — schema foundation for read-only public access.
//
// Introspects the live local Postgres schema (post-migration 0067) to assert
// the visibility column and the user_memex_access table exist with the right
// shape. visibility is the foundation of the owner toggle (ac-4), so these
// tests tag ac-4.

const AC_4 = "mindset-prod/memex-building-itself/specs/spec-111/acs/ac-4";

describe("spec-111 schema: memexes.visibility + user_memex_access", () => {
  it("memexes.visibility exists, NOT NULL, defaults to 'private'", async () => {
    tagAc(AC_4);
    const rows = (await db.execute(
      sql`select column_name, data_type, is_nullable, column_default
          from information_schema.columns
          where table_schema = 'public' and table_name = 'memexes'
            and column_name = 'visibility'`
    )) as unknown as Array<{
      column_name: string;
      data_type: string;
      is_nullable: string;
      column_default: string | null;
    }>;

    expect(rows.length, "memexes.visibility column missing").toBe(1);
    const col = rows[0]!;
    expect(col.data_type).toBe("text");
    expect(col.is_nullable).toBe("NO");
    // postgres renders a text default as: 'private'::text
    expect(col.column_default ?? "").toContain("'private'");
  });

  it("memexes carries a CHECK constraining visibility to public|private", async () => {
    tagAc(AC_4);
    const rows = (await db.execute(
      sql`select pg_get_constraintdef(c.oid) as def
          from pg_constraint c
          where c.conrelid = 'memexes'::regclass
            and c.contype = 'c'
            and c.conname = 'memexes_visibility_valid'`
    )) as unknown as Array<{ def: string }>;

    expect(rows.length, "memexes_visibility_valid CHECK missing").toBe(1);
    const def = rows[0]!.def;
    expect(def).toContain("public");
    expect(def).toContain("private");
  });

  it("every existing memexes row is 'private' after migration", async () => {
    tagAc(AC_4);
    const rows = (await db.execute(
      sql`select count(*)::int as non_private
          from memexes
          where visibility is distinct from 'private'`
    )) as unknown as Array<{ non_private: number }>;

    expect(Number(rows[0]?.non_private ?? -1)).toBe(0);
  });

  it("user_memex_access table exists with uuid FK columns, access_level, added_at", async () => {
    tagAc(AC_4);
    const rows = (await db.execute(
      sql`select column_name, data_type, is_nullable, column_default
          from information_schema.columns
          where table_schema = 'public' and table_name = 'user_memex_access'`
    )) as unknown as Array<{
      column_name: string;
      data_type: string;
      is_nullable: string;
      column_default: string | null;
    }>;

    const byName = new Map(rows.map((r) => [r.column_name, r]));
    expect(byName.has("user_id"), "user_id missing").toBe(true);
    expect(byName.has("memex_id"), "memex_id missing").toBe(true);
    expect(byName.has("access_level"), "access_level missing").toBe(true);
    expect(byName.has("added_at"), "added_at missing").toBe(true);

    expect(byName.get("user_id")!.data_type).toBe("uuid");
    expect(byName.get("memex_id")!.data_type).toBe("uuid");
    expect(byName.get("user_id")!.is_nullable).toBe("NO");
    expect(byName.get("memex_id")!.is_nullable).toBe("NO");

    expect(byName.get("access_level")!.is_nullable).toBe("NO");
    expect(byName.get("access_level")!.column_default ?? "").toContain("'read'");

    // timestamptz with a now() default
    expect(byName.get("added_at")!.data_type).toBe("timestamp with time zone");
    expect(byName.get("added_at")!.is_nullable).toBe("NO");
    expect(byName.get("added_at")!.column_default ?? "").toContain("now()");
  });

  it("user_memex_access has composite PK (user_id, memex_id)", async () => {
    tagAc(AC_4);
    const rows = (await db.execute(
      sql`select pg_get_constraintdef(c.oid) as def
          from pg_constraint c
          where c.conrelid = 'user_memex_access'::regclass
            and c.contype = 'p'`
    )) as unknown as Array<{ def: string }>;

    expect(rows.length, "primary key missing").toBe(1);
    const def = rows[0]!.def;
    expect(def).toContain("user_id");
    expect(def).toContain("memex_id");
  });

  it("user_memex_access constrains access_level to 'read' and FKs CASCADE on delete", async () => {
    tagAc(AC_4);
    const checks = (await db.execute(
      sql`select pg_get_constraintdef(c.oid) as def
          from pg_constraint c
          where c.conrelid = 'user_memex_access'::regclass and c.contype = 'c'`
    )) as unknown as Array<{ def: string }>;
    expect(checks.some((r) => r.def.includes("read")), "access_level CHECK missing").toBe(true);

    const fks = (await db.execute(
      sql`select pg_get_constraintdef(c.oid) as def
          from pg_constraint c
          where c.conrelid = 'user_memex_access'::regclass and c.contype = 'f'`
    )) as unknown as Array<{ def: string }>;
    expect(fks.length, "expected two FK constraints").toBe(2);
    expect(fks.every((r) => r.def.includes("ON DELETE CASCADE"))).toBe(true);
    expect(fks.some((r) => r.def.includes("REFERENCES users")), "users FK missing").toBe(true);
    expect(fks.some((r) => r.def.includes("REFERENCES memexes")), "memexes FK missing").toBe(true);
  });
});
