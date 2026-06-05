import { describe, it, expect } from "vitest";
import { sql } from "drizzle-orm";
import { db } from "./connection.js";
import { tagAc } from "@memex-ai-ac/vitest";

// spec-129 t-1 — schema foundation for authenticated AC emission.
//
// Introspects the live local Postgres schema (post-migration 0071) to assert the
// memex_emission_keys table exists with the right shape, modelled on mcp_tokens. The
// table is the substrate for SHA-256 key storage (ac-14), the soft-revoke model
// (ac-13), and the deliberate absence of any anonymous-emission flag (ac-11).

const AC_14 = "mindset-prod/memex-building-itself/specs/spec-129/acs/ac-14"; // SHA-256 hashed_key, unique-indexed
const AC_13 = "mindset-prod/memex-building-itself/specs/spec-129/acs/ac-13"; // revoked_at soft-revoke column
const AC_11 = "mindset-prod/memex-building-itself/specs/spec-129/acs/ac-11"; // no anonymous-emission flag (dec-3/dec-7)
const AC_4 = "mindset-prod/memex-building-itself/specs/spec-129/acs/ac-4"; // SCOPE: no anonymous-emission path exists
const AC_21 = "mindset-prod/memex-building-itself/specs/spec-129/acs/ac-21"; // created_by_user_id column (dec-8)

type ColumnRow = {
  column_name: string;
  data_type: string;
  is_nullable: string;
  column_default: string | null;
};

describe("spec-129 schema: memex_emission_keys", () => {
  it("table exists with the mcp_tokens-mirrored column set; revoked_at is a nullable soft-revoke", async () => {
    tagAc(AC_13);
    const rows = (await db.execute(
      sql`select column_name, data_type, is_nullable, column_default
          from information_schema.columns
          where table_schema = 'public' and table_name = 'memex_emission_keys'
          order by column_name`
    )) as unknown as ColumnRow[];

    const byName = new Map(rows.map((r) => [r.column_name, r]));
    for (const col of [
      "id",
      "memex_id",
      "name",
      "hashed_key",
      "prefix",
      "last_used_at",
      "revoked_at",
      "created_at",
    ]) {
      expect(byName.has(col), `column ${col} missing`).toBe(true);
    }

    // Soft-revoke (ac-13): revoked_at is a nullable timestamptz. NULL = active key;
    // a set value = revoked. The row is never deleted, so revoking is non-destructive.
    const revokedAt = byName.get("revoked_at")!;
    expect(revokedAt.is_nullable, "revoked_at must be nullable").toBe("YES");
    expect(revokedAt.data_type).toBe("timestamp with time zone");

    // Identity + secret columns are NOT NULL.
    expect(byName.get("memex_id")!.is_nullable).toBe("NO");
    expect(byName.get("name")!.is_nullable).toBe("NO");
    expect(byName.get("hashed_key")!.is_nullable).toBe("NO");
    expect(byName.get("prefix")!.is_nullable).toBe("NO");
  });

  it("hashed_key is UNIQUE (O(1) auth lookup by SHA-256 hash) and memex_id is indexed", async () => {
    tagAc(AC_14);
    const rows = (await db.execute(
      sql`select indexdef from pg_indexes
          where schemaname = 'public' and tablename = 'memex_emission_keys'`
    )) as unknown as Array<{ indexdef: string }>;
    const defs = rows.map((r) => r.indexdef).join("\n");

    // A UNIQUE index covering hashed_key — the auth path hashes the presented key and
    // looks the row up by this column.
    expect(defs, "expected a UNIQUE index on hashed_key").toMatch(
      /UNIQUE INDEX[^\n]*\(hashed_key\)/i
    );
    // A btree index on memex_id backs the per-Memex "list my keys" query.
    expect(defs).toMatch(/memex_emission_keys_memex_id_idx/);
  });

  it("created_by_user_id is a nullable FK to users(id) ON DELETE SET NULL (dec-8 ownership, ac-21)", async () => {
    tagAc(AC_21);
    const cols = (await db.execute(
      sql`select column_name, data_type, is_nullable
          from information_schema.columns
          where table_schema = 'public' and table_name = 'memex_emission_keys'
            and column_name = 'created_by_user_id'`
    )) as unknown as ColumnRow[];
    expect(cols.length, "created_by_user_id column must exist").toBe(1);
    // Nullable: legacy keys (minted before this column) and account-deleted owners.
    expect(cols[0].is_nullable).toBe("YES");
    expect(cols[0].data_type).toBe("uuid");

    // FK → users(id) ON DELETE SET NULL: the key survives its creator's deletion (stays
    // admin-revocable) but loses its member-ownership claim.
    const fks = (await db.execute(
      sql`select pg_get_constraintdef(c.oid) as def
          from pg_constraint c
          where c.conrelid = 'memex_emission_keys'::regclass and c.contype = 'f'`
    )) as unknown as Array<{ def: string }>;
    const defs = fks.map((r) => r.def).join("\n");
    expect(defs).toMatch(
      /FOREIGN KEY \(created_by_user_id\) REFERENCES users\(id\) ON DELETE SET NULL/i
    );

    // The "list my own keys" query is index-backed.
    const idx = (await db.execute(
      sql`select indexdef from pg_indexes
          where schemaname = 'public' and tablename = 'memex_emission_keys'`
    )) as unknown as Array<{ indexdef: string }>;
    expect(idx.map((r) => r.indexdef).join("\n")).toMatch(
      /memex_emission_keys_created_by_user_id_idx/
    );
  });

  it("memex_id FKs memexes(id) ON DELETE CASCADE (deleting a Memex drops its keys)", async () => {
    tagAc(AC_14);
    const rows = (await db.execute(
      sql`select pg_get_constraintdef(c.oid) as def
          from pg_constraint c
          where c.conrelid = 'memex_emission_keys'::regclass and c.contype = 'f'`
    )) as unknown as Array<{ def: string }>;
    const defs = rows.map((r) => r.def).join("\n");
    expect(defs).toMatch(
      /FOREIGN KEY \(memex_id\) REFERENCES memexes\(id\) ON DELETE CASCADE/i
    );
  });

  it("NO allow_anonymous_emission column exists on any table (dec-3 / dec-7: key always required)", async () => {
    tagAc(AC_11);
    tagAc(AC_4); // scope outcome: there is no anonymous-emission path at the data layer
    const rows = (await db.execute(
      sql`select table_name from information_schema.columns
          where table_schema = 'public' and column_name = 'allow_anonymous_emission'`
    )) as unknown as Array<{ table_name: string }>;
    expect(
      rows.length,
      `found allow_anonymous_emission on: ${rows
        .map((r) => r.table_name)
        .join(", ")} — v1 has no anonymous-emission path`
    ).toBe(0);
  });
});
