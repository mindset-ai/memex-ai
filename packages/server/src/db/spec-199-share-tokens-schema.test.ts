import { describe, it, expect } from "vitest";
import { sql } from "drizzle-orm";
import { db } from "./connection.js";
import { tagAc } from "@memex-ai-ac/vitest";

// spec-199 ac-8: share_tokens table has created_by_user_id and expires_at
// after migration 0080 runs.
//
// created_by_user_id: nullable FK → users(id) ON DELETE SET NULL.
//   Nullable for backwards compat with existing tokens that pre-date the
//   migration. Powers the bulk-revoke in disableMembership (ac-10).
//
// expires_at: nullable timestamptz.
//   No default here — the application stamps it at mint time using
//   SHARE_TOKEN_TTL_DAYS. NULL = no expiry (preserves existing tokens).

const AC_8 = "mindset-prod/memex-building-itself/specs/spec-199/acs/ac-8";

describe("spec-199 ac-8: share_tokens schema post-migration-0080", () => {
  it("ac-8: created_by_user_id column is nullable uuid with ON DELETE SET NULL FK to users", async () => {
    tagAc(AC_8);

    const cols = (await db.execute(sql`
      SELECT column_name, data_type, is_nullable, column_default
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'share_tokens'
        AND column_name = 'created_by_user_id'
    `)) as unknown as Array<{
      column_name: string;
      data_type: string;
      is_nullable: string;
      column_default: string | null;
    }>;

    expect(cols.length, "created_by_user_id column missing from share_tokens").toBe(1);
    const col = cols[0]!;
    expect(col.data_type).toBe("uuid");
    expect(col.is_nullable).toBe("YES");
    expect(col.column_default).toBeNull();
  });

  it("ac-8: created_by_user_id FK references users(id) ON DELETE SET NULL", async () => {
    tagAc(AC_8);

    const fks = (await db.execute(sql`
      SELECT pg_get_constraintdef(c.oid) AS def
      FROM pg_constraint c
      WHERE c.conrelid = 'share_tokens'::regclass
        AND c.contype = 'f'
        AND c.conname LIKE '%created_by_user_id%'
    `)) as unknown as Array<{ def: string }>;

    expect(fks.length, "created_by_user_id FK constraint missing").toBe(1);
    const def = fks[0]!.def;
    expect(def).toContain("REFERENCES users");
    expect(def).toContain("ON DELETE SET NULL");
  });

  it("ac-8: expires_at column is nullable timestamptz with no default", async () => {
    tagAc(AC_8);

    const cols = (await db.execute(sql`
      SELECT column_name, data_type, is_nullable, column_default
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'share_tokens'
        AND column_name = 'expires_at'
    `)) as unknown as Array<{
      column_name: string;
      data_type: string;
      is_nullable: string;
      column_default: string | null;
    }>;

    expect(cols.length, "expires_at column missing from share_tokens").toBe(1);
    const col = cols[0]!;
    expect(col.data_type).toBe("timestamp with time zone");
    expect(col.is_nullable).toBe("YES");
    expect(col.column_default).toBeNull();
  });

  it("ac-8: share_tokens_created_by_user_id_idx index exists", async () => {
    tagAc(AC_8);

    const idxs = (await db.execute(sql`
      SELECT indexname
      FROM pg_indexes
      WHERE tablename = 'share_tokens'
        AND indexname = 'share_tokens_created_by_user_id_idx'
    `)) as unknown as Array<{ indexname: string }>;

    expect(idxs.length, "share_tokens_created_by_user_id_idx missing").toBe(1);
  });
});
