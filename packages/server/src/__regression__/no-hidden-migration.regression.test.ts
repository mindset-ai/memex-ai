// spec-358 (dec-5, ac-13/ac-14/ac-15) — NO migration runs against existing
// `test_events` rows. The governing constraint is that not one iota of any
// existing workspace's board may change as a result of this work: historical
// hidden=true rows are frozen, not un-hidden, deleted, or recomputed. The
// `hidden` column is write-frozen, never dropped or renamed here.
//
// This guard scans every Drizzle migration and fails if any of them MUTATES
// existing test_events data via the hidden column (un-hide / set hidden) or
// deletes rows. Structural ADDs (0066 added the column) and read-only filters
// (0075 backfills the summary with `WHERE hidden = false`) are fine — those do
// not change which rows are hidden. If a future migration tries to un-hide or
// delete historical rows, this test goes red.

import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tagAc } from "@memex-ai-ac/vitest";

const SPEC = "mindset-prod/memex-building-itself/specs/spec-358";
const MIGRATIONS_DIR = join(__dirname, "..", "..", "drizzle");

function migrationSql(): Array<{ file: string; sql: string }> {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .map((f) => ({ file: f, sql: readFileSync(join(MIGRATIONS_DIR, f), "utf-8") }));
}

// Strip SQL line comments so a comment mentioning "hidden" can't trip the scan.
function stripComments(sql: string): string {
  return sql
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("--"))
    .join("\n");
}

describe("spec-358: no migration un-hides, deletes, or rewrites historical test_events rows", () => {
  it("no migration performs a data mutation of test_events.hidden [ac-13][ac-14][ac-15]", () => {
    tagAc(`${SPEC}/acs/ac-13`);
    tagAc(`${SPEC}/acs/ac-14`);
    tagAc(`${SPEC}/acs/ac-15`);

    const offenders: string[] = [];
    for (const { file, sql } of migrationSql()) {
      const body = stripComments(sql).toLowerCase();
      // An UPDATE that writes the hidden column (un-hide or re-hide existing rows).
      if (/update\s+"?test_events"?[\s\S]*set[\s\S]*hidden/.test(body)) {
        offenders.push(`${file}: UPDATE test_events ... SET ... hidden`);
      }
      // A DELETE against test_events (would drop historical rows).
      if (/delete\s+from\s+"?test_events"?/.test(body)) {
        offenders.push(`${file}: DELETE FROM test_events`);
      }
    }

    expect(offenders).toEqual([]);
  });

  it("no migration was added by spec-358 (the column is write-frozen, not migrated) [ac-13]", () => {
    tagAc(`${SPEC}/acs/ac-13`);
    // The only migrations that may reference `hidden` are the structural ones
    // that predate this Spec: 0066 (ADD COLUMN) and 0075 (summary backfill,
    // read-only filter). No spec-358 migration exists.
    const referencingHidden = migrationSql()
      .filter(({ sql }) => /hidden/i.test(stripComments(sql)))
      .map(({ file }) => file)
      .sort();
    expect(referencingHidden).toEqual([
      "0066_add_test_events_hidden_metadata.sql",
      "0075_add_test_event_latest.sql",
    ]);
  });
});
