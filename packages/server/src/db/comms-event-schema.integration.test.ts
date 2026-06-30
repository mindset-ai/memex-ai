import { describe, it, expect } from "vitest";
import { getTableColumns, sql } from "drizzle-orm";
import { tagAc } from "@memex-ai-ac/vitest";
import { db } from "./connection.js";
import { commsEvent } from "./schema.js";

// spec-12 (memex-backstage) t-1 — comms_event schema guard.
//
// comms_event is a public.* table OWNED + WRITTEN by core (memex-ai) from the
// Postmark webhook and READ by Backstage cross-tenant via the memex_admin
// BYPASSRLS role. These tests pin its shape against migration 0117: the modelled
// columns match the DB (so the @mindset-ai/db-schema re-export is what Backstage
// consumes typed — ac-13), it links to comms_log via a real FK + carries source_ref,
// it dedups on (source_ref, event_type, occurred_at), it is RLS-EXCLUDED like
// comms_log/usage_events, and it stores only metadata — never a message body.

const AC_COMMS_EVENT = "mindset-prod/memex-backstage/specs/spec-12/acs/ac-13";

const EXPECTED_COLUMNS = [
  "id",
  "comms_log_id",
  "source_ref",
  "event_type",
  "bounce_type",
  "bounce_reason",
  "occurred_at",
  "received_at",
] as const;

describe("spec-12 t-1: comms_event table + shape (ac-13)", () => {
  it("ac-13: comms_event exists in public with exactly the modelled columns", async () => {
    tagAc(AC_COMMS_EVENT);

    const rows = (await db.execute(sql`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'comms_event'
      ORDER BY column_name
    `)) as unknown as Array<{ column_name: string }>;

    const got = rows.map((r) => r.column_name).sort();
    expect(got, "comms_event column set drifted from migration 0117").toEqual(
      [...EXPECTED_COLUMNS].sort(),
    );
  });

  it("ac-13: the modelled schema (re-exported by @mindset-ai/db-schema) matches the DB columns", async () => {
    tagAc(AC_COMMS_EVENT);

    // commsEvent is re-exported verbatim by @mindset-ai/db-schema (packages/db-schema
    // does `export * from server/src/db/schema`), so asserting the modelled shape
    // here IS asserting what Backstage consumes typed.
    const modelled = Object.values(getTableColumns(commsEvent))
      .map((c) => c.name)
      .sort();
    expect(modelled).toEqual([...EXPECTED_COLUMNS].sort());
  });

  it("ac-13: links to comms_log via a FK on comms_log_id and carries source_ref as the join key", async () => {
    tagAc(AC_COMMS_EVENT);

    const fks = (await db.execute(sql`
      SELECT
        att.attname AS column_name,
        confrel.relname AS referenced_table
      FROM pg_constraint con
      JOIN pg_class rel ON rel.oid = con.conrelid
      JOIN pg_class confrel ON confrel.oid = con.confrelid
      JOIN pg_attribute att ON att.attrelid = con.conrelid AND att.attnum = ANY (con.conkey)
      WHERE con.contype = 'f' AND rel.relname = 'comms_event'
    `)) as unknown as Array<{ column_name: string; referenced_table: string }>;

    expect(
      fks.some((f) => f.column_name === "comms_log_id" && f.referenced_table === "comms_log"),
      "comms_event.comms_log_id must FK to comms_log (dec-2)",
    ).toBe(true);

    // source_ref is present (the Postmark MessageID join key Backstage matches on).
    const cols = Object.values(getTableColumns(commsEvent)).map((c) => c.name);
    expect(cols).toContain("source_ref");
  });

  it("ac-13: dedups on (source_ref, event_type, occurred_at) so the webhook is idempotent (dec-6)", async () => {
    tagAc(AC_COMMS_EVENT);

    const rows = (await db.execute(sql`
      SELECT con.conname,
             array_agg(att.attname ORDER BY att.attnum) AS cols
      FROM pg_constraint con
      JOIN pg_class rel ON rel.oid = con.conrelid
      JOIN pg_attribute att ON att.attrelid = con.conrelid AND att.attnum = ANY (con.conkey)
      WHERE con.contype = 'u' AND rel.relname = 'comms_event'
      GROUP BY con.conname
    `)) as unknown as Array<{ conname: string; cols: string[] }>;

    const dedup = rows.find((r) => r.conname === "comms_event_dedup");
    expect(dedup, "comms_event_dedup unique constraint missing").toBeTruthy();
    expect([...dedup!.cols].sort()).toEqual(
      ["source_ref", "event_type", "occurred_at"].sort(),
    );
  });

  it("ac-13: comms_event is RLS-EXCLUDED (relrowsecurity = false), like comms_log", async () => {
    tagAc(AC_COMMS_EVENT);

    const rows = (await db.execute(sql`
      SELECT c.relrowsecurity AS rowsecurity, c.relforcerowsecurity AS forcerowsecurity
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname = 'comms_event'
    `)) as unknown as Array<{ rowsecurity: boolean; forcerowsecurity: boolean }>;

    expect(rows, "comms_event not found in pg_class").toHaveLength(1);
    expect(rows[0]!.rowsecurity, "comms_event must be RLS-excluded (mirrors comms_log)").toBe(false);
    expect(rows[0]!.forcerowsecurity, "comms_event must not be FORCE'd").toBe(false);
  });

  it("ac-13: stores metadata only — no message-body column (dec-4)", async () => {
    tagAc(AC_COMMS_EVENT);

    const modelled = Object.values(getTableColumns(commsEvent)).map((c) => c.name);
    for (const forbidden of ["body", "content", "html", "text_body", "message"]) {
      expect(modelled, `comms_event must not carry a '${forbidden}' column (dec-4: summary only)`).not.toContain(
        forbidden,
      );
    }
  });
});
