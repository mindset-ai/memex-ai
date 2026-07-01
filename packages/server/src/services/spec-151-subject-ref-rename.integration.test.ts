// spec-151 dec-3 (t-2 / ac-9) — the ac_uid → subject_ref column rename landed on
// all three test-event tables, reads go through subject_ref, and the hand-migration
// (0119) is idempotent on a second run.

import { describe, it, expect, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";
import { tagAc } from "@memex-ai-ac/vitest";
import { db } from "../db/connection.js";
import { testEvents } from "../db/schema.js";

const AC_9 = "mindset-prod/memex-building-itself/specs/spec-151/acs/ac-9";

const SUBJECT_TABLES = ["test_events", "test_event_latest", "ac_first_verified"] as const;

const MIGRATION_PATH = resolve(
  fileURLToPath(import.meta.url),
  "../../../drizzle/0119_spec_151_rename_ac_uid_to_subject_ref.sql",
);

const probeRef =
  "mindset-prod/memex-building-itself/standards/std-8/clauses/cl-probe-151";

afterAll(async () => {
  await db.delete(testEvents).where(sql`subject_ref = ${probeRef}`).catch(() => {});
});

async function columnNames(table: string): Promise<string[]> {
  const rows = (await db.execute(sql`
    SELECT column_name FROM information_schema.columns
    WHERE table_name = ${table}
  `)) as unknown as { column_name: string }[];
  return rows.map((r) => r.column_name);
}

describe("spec-151 dec-3 — ac_uid → subject_ref rename (ac-9)", () => {
  it("every test-event table carries subject_ref and NO ac_uid column", async () => {
    tagAc(AC_9);
    for (const table of SUBJECT_TABLES) {
      const cols = await columnNames(table);
      expect(cols, `${table} should carry subject_ref`).toContain("subject_ref");
      expect(cols, `${table} must not retain ac_uid`).not.toContain("ac_uid");
    }
  });

  it("the test_event_latest PRIMARY KEY is now (subject_ref, test_identifier)", async () => {
    tagAc(AC_9);
    const pk = (await db.execute(sql`
      SELECT a.attname AS column_name
      FROM pg_index i
      JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
      WHERE i.indrelid = 'test_event_latest'::regclass AND i.indisprimary
      ORDER BY a.attname
    `)) as unknown as { column_name: string }[];
    expect(pk.map((r) => r.column_name).sort()).toEqual(["subject_ref", "test_identifier"]);
  });

  it("the hand-migration is idempotent — re-applying 0119 is a no-op", async () => {
    tagAc(AC_9);
    const migrationSql = readFileSync(MIGRATION_PATH, "utf8");
    // The guarded DO-block only renames when ac_uid still exists, so a second run
    // must not throw and must leave subject_ref in place.
    await expect(db.execute(sql.raw(migrationSql))).resolves.toBeDefined();
    for (const table of SUBJECT_TABLES) {
      const cols = await columnNames(table);
      expect(cols).toContain("subject_ref");
      expect(cols).not.toContain("ac_uid");
    }
  });

  it("a row round-trips through the renamed subject_ref column", async () => {
    tagAc(AC_9);
    await db.delete(testEvents).where(sql`subject_ref = ${probeRef}`).catch(() => {});
    await db.insert(testEvents).values({
      subjectRef: probeRef,
      memexId: "00000000-0000-0000-0000-000000000000",
      status: "pass",
      testIdentifier: "spec-151::rename round-trip",
    });
    const rows = await db
      .select({ ref: testEvents.subjectRef, status: testEvents.status })
      .from(testEvents)
      .where(sql`subject_ref = ${probeRef}`);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.ref).toBe(probeRef);
  });
});
