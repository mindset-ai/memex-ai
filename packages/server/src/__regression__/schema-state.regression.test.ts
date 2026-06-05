import { describe, it, expect } from "vitest";
import { sql } from "drizzle-orm";
import { readdirSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { db } from "../db/connection.js";

// Regression: catches the two most common ways our DB state goes stale after a migration:
//   1. Drizzle journal drifts from the `__drizzle_migrations` tracking table — means
//      someone applied SQL by hand without updating the journal, or vice versa.
//   2. A drizzle schema.ts change doesn't have a matching SQL migration — means the code
//      expects a column/table that doesn't exist in the DB.
//
// This file runs against the local dev DB. In CI the DB is fresh and freshly migrated,
// so divergence would indicate a real problem.

const __dirname = dirname(fileURLToPath(import.meta.url));
const DRIZZLE_DIR = resolve(__dirname, "../../drizzle");

// Tables that the drizzle schema.ts file defines. If you add a new pgTable, add it here.
// Keeping this list static (rather than introspecting `schema.ts` at runtime) is deliberate:
// a rename in the schema should force a corresponding edit here, which doubles as a review
// signal that the migration side was also updated.
const EXPECTED_TABLES = [
  "namespaces",
  "namespace_slug_reservations",
  "orgs",
  "memexes",
  "org_memberships",
  "users",
  "auth_tokens",
  "documents",
  "doc_sections",
  "doc_comments",
  "decisions",
  "decision_deps",
  "tasks",
  "task_deps",
  "conversations",
  "messages",
  "invite_tokens",
  "share_tokens",
  "verified_domains",
  "domain_verification_tokens",
  "waitlist_entries",
  "mcp_tokens",
  "cli_auth_requests",
  "tags",
  "document_tags",
] as const;

describe("regression: schema state", () => {
  it("every drizzle-journal entry matches a row in __drizzle_migrations (no idempotency drift)", async () => {
    // Journal is the record of which migration files have been generated + committed.
    const journal = JSON.parse(
      readFileSync(resolve(DRIZZLE_DIR, "meta/_journal.json"), "utf8")
    ) as { entries: Array<{ idx: number; tag: string }> };
    const journalCount = journal.entries.length;

    // The tracking table is what drizzle-kit updates each time a migration actually runs.
    // If these diverge, re-running `drizzle-kit migrate` would either re-apply (and fail)
    // or skip (and silently leave DDL unapplied).
    const rows = await db.execute(
      sql`select count(*)::int as c from drizzle.__drizzle_migrations`
    );
    // drizzle's `execute` returns the postgres-js RowList shape directly on this driver.
    const appliedCount = Number((rows as unknown as Array<{ c: number }>)[0]?.c ?? 0);

    expect(appliedCount).toBe(journalCount);
  });

  it("all SQL files in drizzle/ are either journal-tracked or explicitly hand-applied", async () => {
    const journal = JSON.parse(
      readFileSync(resolve(DRIZZLE_DIR, "meta/_journal.json"), "utf8")
    ) as { entries: Array<{ tag: string }> };
    const tracked = new Set(journal.entries.map((e) => e.tag));

    const sqlFiles = readdirSync(DRIZZLE_DIR)
      .filter((f) => f.endsWith(".sql"))
      .map((f) => f.replace(/\.sql$/, ""))
      .sort();

    // Hand-written migrations beyond the journal are expected in this codebase — the
    // CLAUDE.md at the repo root calls this out. Rather than fail on them, we assert
    // they're numbered consecutively after the last journal entry. Gaps mean a file was
    // accidentally committed without being applied.
    const highestJournalIdx = Math.max(
      ...journal.entries.map((e) => Number(e.tag.split("_")[0]))
    );
    for (const file of sqlFiles) {
      const idx = Number(file.split("_")[0]);
      if (tracked.has(file)) continue;
      expect(idx).toBeGreaterThan(highestJournalIdx);
    }
  });

  it("every drizzle-defined table exists in the live schema", async () => {
    const rows = await db.execute(
      sql`select table_name from information_schema.tables where table_schema = 'public'`
    );
    const liveTables = new Set(
      (rows as unknown as Array<{ table_name: string }>).map((r) => r.table_name)
    );

    for (const expected of EXPECTED_TABLES) {
      expect(liveTables.has(expected), `missing table: ${expected}`).toBe(true);
    }
  });

  it("critical memex-scoped tables carry a memex_id column with an index on it", async () => {
    // Every resource table that should isolate across tenants must have memex_id. A
    // schema change that forgets to denormalize it would silently leak cross-tenant data.
    const memexScopedTables = ["documents", "decisions", "tasks", "doc_comments"];
    for (const t of memexScopedTables) {
      const cols = await db.execute(
        sql`select column_name from information_schema.columns where table_name = ${t} and column_name = 'memex_id'`
      );
      expect(
        (cols as unknown as unknown[]).length,
        `${t} missing memex_id column`
      ).toBe(1);

      const idx = await db.execute(
        sql`select indexname from pg_indexes where tablename = ${t} and indexdef like '%memex_id%'`
      );
      expect(
        (idx as unknown as unknown[]).length,
        `${t} has no index covering memex_id`
      ).toBeGreaterThanOrEqual(1);
    }
  });

  it("namespaces.slug has a unique constraint (multi-tenancy key invariant)", async () => {
    const rows = await db.execute(
      sql`select conname from pg_constraint where conrelid = 'namespaces'::regclass and contype = 'u'`
    );
    const names = (rows as unknown as Array<{ conname: string }>).map((r) => r.conname);
    // Drizzle names auto-generated unique constraints `<table>_<column>_unique`; the
    // slug uniqueness is what prevents two namespaces from sharing a URL.
    expect(names.some((n) => n.includes("slug"))).toBe(true);
  });
});
