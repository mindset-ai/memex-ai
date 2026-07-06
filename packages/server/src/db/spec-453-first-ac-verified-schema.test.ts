import { describe, it, expect } from "vitest";
import { sql } from "drizzle-orm";
import { db } from "./connection.js";

// spec-453 t-1 — schema foundation for the "See it verified" milestone gate.
//
// Introspects the live (post-migration 0125) users table to assert the
// first_ac_verified_at GATE SENTINEL has the exact shape the gate logic (t-2)
// depends on: it exists, it is a nullable timestamptz, and — load-bearing — it
// has NO column default. A DEFAULT now() would auto-stamp every new signup, so
// NULL would never occur and nobody would ever be eligible for the milestone
// email (a silent gate bug). This test is a STRUCTURAL REGRESSION GUARD for that
// shape — intentionally UNTAGGED: it does not exercise any behavioural AC. The
// milestone behaviour (fires on `verified` only, first-ever-only, attribution via
// the emission key — ac-9/ac-12; pre-existing exclusion — ac-18) is exercised and
// tagged in t-2. Tagging a behavioural AC off a schema-shape check would be a
// false green.

type ColumnRow = {
  column_name: string;
  data_type: string;
  is_nullable: string;
  column_default: string | null;
};

describe("spec-453 schema: users.first_ac_verified_at", () => {
  it("exists as a nullable timestamptz with NO default", async () => {
    const rows = (await db.execute(
      sql`select column_name, data_type, is_nullable, column_default
          from information_schema.columns
          where table_schema = 'public'
            and table_name = 'users'
            and column_name = 'first_ac_verified_at'`
    )) as unknown as ColumnRow[];

    expect(rows.length, "first_ac_verified_at column missing").toBe(1);
    const col = rows[0];

    // Nullable — NULL is the "eligible / not yet verified" sentinel value.
    expect(col.is_nullable).toBe("YES");

    // timestamptz, matching Drizzle timestamp({ withTimezone: true }).
    expect(col.data_type).toBe("timestamp with time zone");

    // NO DEFAULT — the load-bearing guard. A default would make NULL unreachable
    // and silently disable the whole milestone gate.
    expect(col.column_default).toBeNull();
  });
});
