// spec-398 — the bounded-retention migration (0111) must be deadlock-proof.
//
// The first prod release of 0111 deadlocked (Postgres 40P01) against live traffic
// and rolled the whole file back. Cause: a two-table lock-order cycle.
//   • 0111 mutates test_event_latest (§1 ALTER … ADD memex_id) BEFORE test_events
//     (§2 rewrite-and-swap) — lock order test_event_latest → test_events.
//   • Live /api/test-events emissions, in one transaction, INSERT test_events then
//     upsert test_event_latest (routes/test-events.ts) — lock order test_events →
//     test_event_latest, the OPPOSITE.
// Two transactions taking the same two locks in opposite orders is the textbook
// deadlock, and test_events is written continuously, so it was near-certain.
//
// The fix: 0111 takes BOTH locks up front, in the EMISSION order (test_events
// first), under a bounded lock_timeout — before any DDL/DML. The cycle is gone
// (everyone now requests test_events first); the migration either wins a clean
// exclusive window or fails fast on lock_timeout and retries next deploy. It can
// never deadlock again.
//
// The LOCK is wrapped in a DO $$ … $$ block, NOT a bare `LOCK TABLE`, because the
// file is applied two ways: the prod/dev hand-runner wraps each file in ONE
// transaction (a bare LOCK would work), but the e2e-cold template build pipes each
// file through `psql -f` in AUTOCOMMIT, where a bare LOCK errors ("can only be used
// in transaction blocks", PG16). A DO block runs its body in an implicit transaction
// in BOTH paths. The bare-LOCK regression is silent (e2e-cold goes red only at
// template-build), so the DO-block wrapper is guarded explicitly below.
//
// This is a STATIC GUARD on the migration file: it fails if the up-front lock guard
// is ever removed, reordered out of emission order, made unbounded, pushed below the
// first schema statement, or un-wrapped from its DO block. It tags ac-4 (the
// rewrite-and-swap) — the lock guard is what makes that swap safely applicable
// against a live, continuously-written table.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { tagAc } from "@memex-ai-ac/vitest";

const SPEC = "mindset-prod/memex-building-itself/specs/spec-398";
const MIGRATION = join(
  __dirname,
  "..",
  "..",
  "drizzle",
  "0111_test_events_retention_and_memex_id.sql",
);

const raw = readFileSync(MIGRATION, "utf-8");

// Strip SQL line comments so prose mentioning ALTER/LOCK can't skew the positions.
function stripComments(sql: string): string {
  return sql
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("--"))
    .join("\n");
}

const body = stripComments(raw);
const lower = body.toLowerCase();

describe("spec-398 ac-4: the 0111 retention migration is deadlock-proof (static guard)", () => {
  it("takes both table locks up front in ACCESS EXCLUSIVE MODE", () => {
    tagAc(`${SPEC}/acs/ac-4`);
    // One LOCK statement naming BOTH tables in ACCESS EXCLUSIVE MODE.
    expect(lower).toMatch(
      /lock\s+table\s+test_events\s*,\s*test_event_latest\s+in\s+access\s+exclusive\s+mode/,
    );
  });

  it("wraps the LOCK in a DO block so it survives BOTH the transactional runner and autocommit psql -f", () => {
    tagAc(`${SPEC}/acs/ac-4`);
    // A bare `LOCK TABLE` errors under the e2e-cold template build (psql -f,
    // autocommit). The DO block makes it valid there too. Guard the wrapper so a
    // future "simplification" back to a bare LOCK can't silently break e2e-cold.
    expect(lower).toMatch(
      /do\s+\$\$\s*begin[\s\S]*lock\s+table\s+test_events\s*,\s*test_event_latest\s+in\s+access\s+exclusive\s+mode[\s\S]*end\s*\$\$/,
    );
  });

  it("locks in the APP's emission order — test_events BEFORE test_event_latest", () => {
    tagAc(`${SPEC}/acs/ac-4`);
    // Live emissions lock test_events first; the migration must agree, or the
    // cycle re-forms. Assert the order within the LOCK statement explicitly.
    const lockStmt = lower.match(/lock\s+table\s+([^;]+?)\s+in\s+access\s+exclusive/);
    expect(lockStmt, "LOCK TABLE … IN ACCESS EXCLUSIVE statement must exist").not.toBeNull();
    const tablesText = lockStmt![1];
    expect(tablesText.indexOf("test_events")).toBeLessThan(
      tablesText.indexOf("test_event_latest"),
    );
  });

  it("bounds the wait with a lock_timeout so it fails fast instead of hanging", () => {
    tagAc(`${SPEC}/acs/ac-4`);
    // A bounded timeout is what turns "deadlock against traffic" into "fail fast,
    // retry next deploy". An unbounded LOCK could block indefinitely behind a long
    // reader. Require lock_timeout to be SET, and SET before the LOCK is requested.
    expect(lower).toMatch(/set\s+lock_timeout\s*=\s*'[^']+'/);
    const setIdx = lower.search(/set\s+lock_timeout/);
    const lockIdx = lower.search(/lock\s+table\s+test_events/);
    expect(setIdx).toBeGreaterThanOrEqual(0);
    expect(lockIdx).toBeGreaterThan(setIdx);
  });

  it("acquires the locks BEFORE any schema/data statement (no DDL runs unlocked)", () => {
    tagAc(`${SPEC}/acs/ac-4`);
    const lockIdx = lower.search(/lock\s+table\s+test_events/);
    expect(lockIdx).toBeGreaterThanOrEqual(0);
    // The first real mutating statement in the file: §1's ALTER … ADD memex_id, or
    // any CREATE/UPDATE/DELETE/DROP/INSERT. Whichever comes first MUST come after
    // the lock — otherwise that statement runs in the old (deadlock-prone) order.
    const firstDdlIdx = lower.search(
      /\b(alter\s+table|create\s+table|create\s+or\s+replace\s+view|update\s+|delete\s+from|drop\s+(table|view)|insert\s+into)\b/,
    );
    expect(firstDdlIdx).toBeGreaterThanOrEqual(0);
    expect(
      lockIdx,
      "LOCK TABLE must precede the first schema/data statement",
    ).toBeLessThan(firstDdlIdx);
  });
});
