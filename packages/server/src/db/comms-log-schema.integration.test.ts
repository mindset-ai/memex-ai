import { describe, it, expect } from "vitest";
import { getTableColumns, sql } from "drizzle-orm";
import { tagAc } from "@memex-ai-ac/vitest";
import { db } from "./connection.js";
import { commsLog } from "./schema.js";

// spec-6 (memex-backstage) t-1 — comms_log schema guard.
//
// comms_log is a public.* table OWNED + WRITTEN by core (memex-ai) and READ by
// Backstage cross-tenant via the memex_admin BYPASSRLS role (spec-6 dec-5). These
// tests pin the table's shape against the migration (0104), prove it is modelled
// in the shared schema the @mindset-ai/db-schema package re-exports (so Backstage
// reads it typed — ac-16), prove it is RLS-EXCLUDED like usage_events/visitors so
// a contextless send-path write or a BYPASSRLS read is never FORCE-filtered
// (ac-7), and prove it stores only a summary line — never a body column (ac-13 /
// dec-4).

const AC_TABLE = "mindset-prod/memex-backstage/specs/spec-6/acs/ac-7";
const AC_PUBLIC_OWNED = "mindset-prod/memex-backstage/specs/spec-6/acs/ac-16";
const AC_SUMMARY_ONLY = "mindset-prod/memex-backstage/specs/spec-6/acs/ac-13";

const EXPECTED_COLUMNS = [
  "id",
  "user_id",
  "channel",
  "type",
  "status",
  "scheduled_for",
  "sent_at",
  "subject",
  "source_ref",
  "created_at",
] as const;

describe("spec-6 t-1: comms_log table + shape (ac-7)", () => {
  it("ac-7: comms_log exists in public with exactly the modelled columns", async () => {
    tagAc(AC_TABLE);

    const rows = (await db.execute(sql`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'comms_log'
      ORDER BY column_name
    `)) as unknown as Array<{ column_name: string }>;

    const got = rows.map((r) => r.column_name).sort();
    expect(got, "comms_log column set drifted from migration 0104").toEqual(
      [...EXPECTED_COLUMNS].sort(),
    );
  });

  it("ac-7: the channel + status CHECK constraints are present", async () => {
    tagAc(AC_TABLE);

    const rows = (await db.execute(sql`
      SELECT conname
      FROM pg_constraint
      WHERE conrelid = 'public.comms_log'::regclass AND contype = 'c'
      ORDER BY conname
    `)) as unknown as Array<{ conname: string }>;

    const names = rows.map((r) => r.conname);
    expect(names).toContain("comms_log_channel_valid");
    expect(names).toContain("comms_log_status_valid");
  });

  it("ac-7: comms_log is RLS-EXCLUDED (relrowsecurity = false), so contextless writes/BYPASSRLS reads are never FORCE-filtered", async () => {
    tagAc(AC_TABLE);

    const rows = (await db.execute(sql`
      SELECT c.relrowsecurity AS rowsecurity, c.relforcerowsecurity AS forcerowsecurity
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname = 'comms_log'
    `)) as unknown as Array<{ rowsecurity: boolean; forcerowsecurity: boolean }>;

    expect(rows, "comms_log not found in pg_class").toHaveLength(1);
    expect(rows[0]!.rowsecurity, "comms_log must be RLS-excluded (mirrors usage_events/visitors)").toBe(false);
    expect(rows[0]!.forcerowsecurity, "comms_log must not be FORCE'd").toBe(false);
  });
});

describe("spec-6 t-1: comms_log is modelled in the shared schema (ac-16)", () => {
  it("ac-16: the shared db-schema models comms_log as a public table with the migration's columns", async () => {
    tagAc(AC_PUBLIC_OWNED);

    // commsLog is re-exported verbatim by @mindset-ai/db-schema (packages/db-schema
    // does `export * from server/src/db/schema`), so asserting the modelled shape
    // here IS asserting what Backstage consumes typed.
    const modelled = Object.values(getTableColumns(commsLog))
      .map((c) => c.name)
      .sort();
    expect(modelled).toEqual([...EXPECTED_COLUMNS].sort());

    // And the DB actually has the table (core owns + creates it in public.*).
    const present = (await db.execute(sql`
      SELECT 1 AS ok
      FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = 'comms_log'
    `)) as unknown as Array<{ ok: number }>;
    expect(present).toHaveLength(1);
  });
});

describe("spec-6 t-1: comms_log stores summary only, never a body (ac-13 / dec-4)", () => {
  it("ac-13: no message-body/content column exists — the log holds metadata + a one-line subject only", async () => {
    tagAc(AC_SUMMARY_ONLY);

    const modelled = Object.values(getTableColumns(commsLog)).map((c) => c.name);
    for (const forbidden of ["body", "content", "html", "text_body", "message"]) {
      expect(modelled, `comms_log must not carry a '${forbidden}' column (dec-4: summary only)`).not.toContain(forbidden);
    }
    // It DOES carry the one-line summary surface.
    expect(modelled).toContain("subject");
  });
});
