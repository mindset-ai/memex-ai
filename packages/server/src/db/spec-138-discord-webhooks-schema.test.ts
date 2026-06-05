import { describe, it, expect } from "vitest";
import { sql } from "drizzle-orm";
import { db } from "./connection.js";
import { tagAc } from "@memex-ai-ac/vitest";

// spec-138 t-1 — schema foundation for Discord webhook integration.
//
// Introspects the live local Postgres schema (post-migration 0074) to assert the
// org_discord_webhooks table exists with the right shape (ac-6) and that org_id is
// a PRIMARY KEY enforcing one-webhook-per-org uniqueness (ac-7).

const AC_6 = "mindset-prod/memex-building-itself/specs/spec-138/acs/ac-6";
const AC_7 = "mindset-prod/memex-building-itself/specs/spec-138/acs/ac-7";

type ColumnRow = {
  column_name: string;
  data_type: string;
  is_nullable: string;
  column_default: string | null;
};

describe("spec-138 schema: org_discord_webhooks", () => {
  it("table exists with the expected columns and nullability", async () => {
    tagAc(AC_6);
    const rows = (await db.execute(
      sql`select column_name, data_type, is_nullable, column_default
          from information_schema.columns
          where table_schema = 'public' and table_name = 'org_discord_webhooks'
          order by column_name`
    )) as unknown as ColumnRow[];

    const byName = new Map(rows.map((r) => [r.column_name, r]));

    for (const col of ["org_id", "webhook_url", "channel_name", "created_at", "updated_at"]) {
      expect(byName.has(col), `column ${col} missing`).toBe(true);
    }

    // webhook_url is required — no Discord target without it.
    expect(byName.get("webhook_url")!.is_nullable).toBe("NO");

    // channel_name is display-only and optional.
    expect(byName.get("channel_name")!.is_nullable).toBe("YES");

    // Timestamps are NOT NULL with a server-side default.
    expect(byName.get("created_at")!.is_nullable).toBe("NO");
    expect(byName.get("updated_at")!.is_nullable).toBe("NO");
  });

  it("org_id is the PRIMARY KEY — one webhook per org, enforced at the DB level", async () => {
    tagAc(AC_7);
    const rows = (await db.execute(
      sql`select pg_get_constraintdef(c.oid) as def, c.contype
          from pg_constraint c
          where c.conrelid = 'org_discord_webhooks'::regclass`
    )) as unknown as Array<{ def: string; contype: string }>;

    const pk = rows.find((r) => r.contype === "p");
    expect(pk, "PRIMARY KEY constraint missing").toBeDefined();
    expect(pk!.def).toMatch(/org_id/);
  });

  it("org_id FK references orgs(id) ON DELETE CASCADE", async () => {
    tagAc(AC_7);
    const rows = (await db.execute(
      sql`select pg_get_constraintdef(c.oid) as def
          from pg_constraint c
          where c.conrelid = 'org_discord_webhooks'::regclass and c.contype = 'f'`
    )) as unknown as Array<{ def: string }>;

    const defs = rows.map((r) => r.def).join("\n");
    expect(defs).toMatch(
      /FOREIGN KEY \(org_id\) REFERENCES orgs\(id\) ON DELETE CASCADE/i
    );
  });
});
