#!/usr/bin/env node
// Drift gate: introspect a (freshly-migrated, cold) database and diff it
// against THIS package's published schema. Exits non-zero on divergence so a
// pinned consumer can never silently run against a stale schema. spec-279
// ac-3/ac-10. The pure diff core is exported for unit tests.
import postgres from "postgres";
import { is } from "drizzle-orm";
import { PgTable, getTableConfig } from "drizzle-orm/pg-core";
import * as schema from "../dist/index.js";

// Objects the schema doesn't model as first-class tables — never count as drift.
const IGNORED_TABLES = new Set(["__drizzle_migrations"]);

/** Expected shape from the package schema: Map<table, Set<column>> (public schema only). */
export function expectedFromSchema(mod) {
  const expected = new Map();
  for (const value of Object.values(mod)) {
    if (!is(value, PgTable)) continue;
    const cfg = getTableConfig(value);
    if (cfg.schema && cfg.schema !== "public") continue;
    expected.set(cfg.name, new Set(cfg.columns.map((c) => c.name)));
  }
  return expected;
}

/** Actual shape introspected from the DB: Map<table, Set<column>> (base tables, public schema). */
export async function introspectDb(sql) {
  const rows = await sql`
    select c.table_name, c.column_name
    from information_schema.columns c
    join information_schema.tables t
      on t.table_schema = c.table_schema and t.table_name = c.table_name
    where c.table_schema = 'public' and t.table_type = 'BASE TABLE'
  `;
  const actual = new Map();
  for (const { table_name, column_name } of rows) {
    if (IGNORED_TABLES.has(table_name)) continue;
    if (!actual.has(table_name)) actual.set(table_name, new Set());
    actual.get(table_name).add(column_name);
  }
  return actual;
}

/**
 * Pure diff between the package schema (expected) and the live DB (actual).
 *
 * The package schema is an intentional TYPED SUBSET of the database: the real
 * DB carries columns the schema deliberately does not model (pgvector
 * `embedding*`, tsvector `content_tsv`, and bookkeeping tables like
 * `manual_migrations`), because Drizzle doesn't first-class those Postgres
 * types and they're managed by hand migrations. So the two directions are NOT
 * symmetric:
 *   - `failures` — something the package DECLARES that the DB LACKS (a missing
 *     table or column). This is the stale-package danger: a pinned consumer
 *     would query a table/column that no longer exists → runtime error. CI red.
 *   - `info` — something the DB has that the package doesn't model. Harmless to
 *     a consumer (they simply don't see it). Logged, never fails the gate.
 *
 * Returns { failures, info }; empty `failures` = the package is safe to pin.
 */
export function diffSchemas(expected, actual) {
  const failures = [];
  const info = [];
  for (const [table, cols] of expected) {
    const actualCols = actual.get(table);
    if (!actualCols) {
      failures.push(`missing table in DB: ${table}`);
      continue;
    }
    for (const col of cols) {
      if (!actualCols.has(col)) failures.push(`missing column in DB: ${table}.${col}`);
    }
  }
  for (const [table, cols] of actual) {
    if (!expected.has(table)) {
      info.push(`extra table in DB (not modelled by the package): ${table}`);
      continue;
    }
    for (const col of cols) {
      if (!expected.get(table).has(col)) info.push(`extra column in DB (not modelled): ${table}.${col}`);
    }
  }
  return { failures, info };
}

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL is required");
    process.exit(2);
  }
  const sql = postgres(url, { max: 1, onnotice: () => {} });
  try {
    const { failures, info } = diffSchemas(expectedFromSchema(schema), await introspectDb(sql));
    if (info.length > 0) {
      console.log(`ℹ ${info.length} DB object(s) not modelled by the package (allowed):`);
      for (const i of info) console.log(`  - ${i}`);
    }
    if (failures.length === 0) {
      console.log("✓ db-schema drift gate: every table/column the package declares exists in the DB");
      process.exit(0);
    }
    console.error(`✗ db-schema drift gate: ${failures.length} divergence(s) — the package is stale vs the DB:`);
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

// Run main() only when invoked directly (not when imported by tests).
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exit(2);
  });
}
