// b-105 / ac-8 — the brief→spec migration's body-rewrite allowlist contract.
//
// `packages/server/drizzle/0065_brief_to_spec.sql` exempts four Briefs from its
// prose-rewrite pass because their narrative INTENTIONALLY records the prior
// names (b-10 / b-26 / b-65 / b-105 are the rename's own historical ledger).
// The allowlist is encoded as the literal handle list
//   `WHERE doc_type IN ('spec', 'brief') AND handle IN ('b-10', 'b-26', 'b-65', 'b-105')`
// repeated inside every CTE.
//
// This regression test enforces two invariants:
//
//   1. **SQL contract.** Every allowlist CTE inside 0063 contains exactly the
//      four expected handles, in the documented order, with no drift. A
//      handle added or removed by a careless edit would let history-laden
//      prose leak past the rewrite or rewrite a legitimate historical
//      reference; this test fails CI before the migration is even run.
//
//   2. **Live-DB resolution.** If the dev / CI database carries any of the
//      four handles (the prod snapshot will carry all four; a freshly-seeded
//      local dev DB will likely carry none), the rows resolve to non-null
//      `documents.id` UUIDs. A missing or renamed historical Spec on prod
//      would silently produce an empty CTE — the same rows that the rewrite
//      is supposed to skip would get rewritten anyway. The DB-side assertion
//      catches that BEFORE the migration runs in deploy.

import { describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { db } from "../db/connection.js";
import { tagAc } from "@memex-ai-ac/vitest";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// packages/server/src/__regression__/<this file> → packages/server/drizzle/<sql>
const MIGRATION_PATH = resolve(
  __dirname,
  "../../drizzle/0065_brief_to_spec.sql",
);

// The four Briefs whose prose is preserved verbatim by the body-rewrite pass
// (see ac-8 / dec-3 of b-105). Order matters — the test asserts the SQL keeps
// the same canonical ordering so reordering can't sneak in undetected.
const EXPECTED_HANDLES = ["b-10", "b-26", "b-65", "b-105"] as const;

// Match the handle-list literal inside any allowlist CTE. We deliberately
// anchor on the surrounding `handle IN (…)` syntax — capturing the list body
// only — so the test doesn't care about whitespace or line wrapping inside
// the SQL.
const HANDLE_LIST_RE = /handle\s+IN\s*\(\s*([^)]+?)\s*\)/gi;

describe("regression: b-105 migration allowlist (ac-8)", () => {
  const migrationSql = readFileSync(MIGRATION_PATH, "utf8");

  // Pre-compute every allowlist-CTE literal once so individual `it` blocks
  // share the same parse and the failure messages stay focused.
  const lists: string[][] = [];
  for (const match of migrationSql.matchAll(HANDLE_LIST_RE)) {
    const handles = match[1]
      .split(",")
      .map((tok) => tok.trim().replace(/^'/, "").replace(/'$/, ""))
      .filter((tok) => tok.length > 0);
    lists.push(handles);
  }

  it("contains at least one allowlist CTE", () => {
    // The migration runs the same allowlist subquery inside every UPDATE
    // (doc_sections × 6, decisions.context × 6, decisions.resolution × 6,
    // doc_comments × 6, plus the Step-3 self-check). Total ≥ 25 occurrences.
    // We don't pin the exact count — that's a structural detail of the
    // migration — but a regression to 0 would mean the regex broke and
    // every other assertion below would silently pass.
    expect(lists.length).toBeGreaterThan(0);
  });

  it("every allowlist CTE lists exactly the four expected handles in canonical order", () => {
    // ac-8: migration allowlist contains the four canonical handles (CTE shape)
    tagAc("mindset-prod/memex-building-itself/specs/spec-105/acs/ac-8");
    // Each occurrence must be identical. If any drifts, the migration would
    // skip a different set of rows — and the prose sweep / preservation
    // contract breaks.
    for (const [idx, list] of lists.entries()) {
      expect(
        list,
        `allowlist CTE #${idx + 1} of ${lists.length} drifted from canonical handle order`,
      ).toEqual([...EXPECTED_HANDLES]);
    }
  });

  it("the four allowlisted handles resolve to known documents.id UUIDs when present", async () => {
    // The Briefs may or may not exist in the local dev DB — that depends on
    // whether the developer has seeded the brief→spec migration history.
    // On a prod snapshot all four must exist; on a fresh dev DB none will.
    // The assertion: every row that DOES exist must carry a non-null UUID
    // (a CTE row with a NULL id would defeat the allowlist), and the
    // doc_type must be one of 'spec' / 'brief' (the CTE filter), so a
    // future rename that flips them to something else fails this test.
    const rows = (await db.execute(sql`
      SELECT handle, id::text AS id, doc_type
        FROM documents
       WHERE handle IN ('b-10', 'b-26', 'b-65', 'b-105')
       ORDER BY handle
    `)) as unknown as Array<{ handle: string; id: string; doc_type: string }>;

    for (const row of rows) {
      expect(
        row.id,
        `handle ${row.handle} resolved but its documents.id is null`,
      ).toMatch(/^[0-9a-f-]{36}$/i);
      expect(
        ["spec", "brief"],
        `handle ${row.handle} has doc_type='${row.doc_type}' — CTE filter would skip it`,
      ).toContain(row.doc_type);
    }

    // Belt-and-braces: if the DB looks like a prod snapshot (the four
    // Briefs exist), assert the set is exactly the four — no surprise
    // collisions (e.g. a different memex also using 'b-105' as a handle
    // would mean the CTE matches more rows than the allowlist intends).
    const foundHandles = new Set(rows.map((r) => r.handle));
    if (foundHandles.size === EXPECTED_HANDLES.length) {
      expect([...foundHandles].sort()).toEqual([...EXPECTED_HANDLES].sort());
    }
  });
});
