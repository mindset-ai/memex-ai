// spec-520 t-12 (ac-13) — EVERY migration that locks test_events must do it the way 0111
// eventually learned to, not just the one that learned it.
//
// WHY THIS EXISTS SEPARATELY FROM spec-398's GUARD. That guard is hardcoded to
// `0111_test_events_retention_and_memex_id.sql`. It was written the day 0111's lock
// discipline was fixed and it pins exactly that file — so 0142, which restructures the same
// table and carries exactly the same hazard, shipped with no guard at all. The next one
// would too.
//
// THE HAZARD IT GUARDS. 0111's first production release deadlocked (Postgres 40P01) against
// live traffic and rolled the whole file back — std-39 cl-9's worked example. The cause was
// lock ORDER: the migration took test_event_latest before test_events, while every live
// emission takes them the other way round (routes/test-events.ts). Two parties, two locks,
// opposite orders.
//
// This scans EVERY migration that takes ACCESS EXCLUSIVE on test_events and holds each to
// the same four rules, so the discipline is a property of the table rather than a property
// of one file someone remembered to pin.

import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tagAc } from "@memex-ai-ac/vitest";

const AC_PARTITIONED = "mindset-prod/memex-building-itself/specs/spec-520/acs/ac-13";
const DIR = join(__dirname, "..", "..", "drizzle");

/** Strip line comments so prose ABOUT locking cannot satisfy — or trip — the scan. */
function stripComments(sql: string): string {
  return sql
    .split("\n")
    .filter((l) => !l.trimStart().startsWith("--"))
    .join("\n");
}

/** Every migration that actually takes ACCESS EXCLUSIVE on test_events. */
function lockingMigrations(): Array<{ file: string; sql: string }> {
  return readdirSync(DIR)
    .filter((f) => f.endsWith(".sql"))
    .map((f) => ({ file: f, sql: stripComments(readFileSync(join(DIR, f), "utf-8")).toLowerCase() }))
    .filter(({ sql }) => /lock\s+table[^;]*test_events[^;]*access\s+exclusive/s.test(sql));
}

describe("spec-520 ac-13 — lock discipline on every test_events migration", () => {
  it("finds the migrations to hold to the rule (a scan that matches nothing proves nothing)", () => {
    tagAc(AC_PARTITIONED);
    const files = lockingMigrations().map((m) => m.file);
    // Without this, a regex that silently stopped matching would leave every assertion
    // below vacuously green — the failure mode of every allowlist-shaped guard.
    expect(files).toContain("0111_test_events_retention_and_memex_id.sql");
    expect(files).toContain("0142_spec520_partition_test_events.sql");
  });

  for (const { file, sql } of lockingMigrations()) {
    describe(file, () => {
      it("locks in the APP's emission order — test_events BEFORE test_event_latest", () => {
        tagAc(AC_PARTITIONED);
        // Order of ACQUISITION, not of syntax. Both forms are legitimate and both appear in
        // this directory: 0111 uses one combined `LOCK TABLE a, b`, 0142 uses two separate
        // statements. A guard that only understood one form would have passed the other
        // vacuously — which is how a lock-order guard silently stops guarding.
        const stmts = [...sql.matchAll(/lock\s+table([^;]*)in\s+access\s+exclusive\s+mode/gs)]
          .map((m) => m[1]);
        const acquisition = stmts.join(" | ");
        // THE ACTUAL 0111 BUG. Reversing these two is what deadlocked production.
        expect(acquisition).toContain("test_events");
        expect(acquisition).toContain("test_event_latest");
        expect(acquisition.indexOf("test_events")).toBeLessThan(
          acquisition.indexOf("test_event_latest"),
        );
      });

      it("bounds the wait with a lock_timeout set BEFORE the lock", () => {
        tagAc(AC_PARTITIONED);
        expect(sql).toMatch(/set\s+(local\s+)?lock_timeout\s*=\s*'[^']+'/);
        const setIdx = sql.search(/set\s+(local\s+)?lock_timeout/);
        const lockIdx = sql.search(/lock\s+table/);
        // Set afterwards it protects nothing: the migration would already be queued behind
        // live traffic on the hottest table in the system, holding the deploy open.
        expect(setIdx).toBeGreaterThanOrEqual(0);
        expect(lockIdx).toBeGreaterThan(setIdx);
      });

      it("wraps the LOCK in a DO block, so it survives the transactional runner AND autocommit psql -f", () => {
        tagAc(AC_PARTITIONED);
        // These files are applied two ways: apply-hand-migrations wraps each in ONE
        // transaction, while the e2e-cold template build pipes them through `psql -f` in
        // AUTOCOMMIT — where a bare LOCK TABLE errors with "can only be used in transaction
        // blocks". A DO block runs its body in an implicit transaction in both.
        const lockIdx = sql.search(/lock\s+table/);
        const doIdx = sql.lastIndexOf("do $$", lockIdx);
        expect(doIdx).toBeGreaterThanOrEqual(0);
        expect(doIdx).toBeLessThan(lockIdx);
      });

      it("acquires the locks BEFORE any schema or data statement", () => {
        tagAc(AC_PARTITIONED);
        const lockIdx = sql.search(/lock\s+table/);
        const firstDdl = sql.search(
          /\b(create\s+table|alter\s+table|create\s+index|drop\s+table|drop\s+view|insert\s+into|update\s+|delete\s+from)/,
        );
        expect(lockIdx).toBeGreaterThanOrEqual(0);
        // A statement that runs before the lock runs unlocked — it can take its own lock in
        // the wrong order and reopen the exact cycle the up-front LOCK exists to close.
        if (firstDdl >= 0) expect(lockIdx).toBeLessThan(firstDdl);
      });
    });
  }
});
