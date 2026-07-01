// The tenant-context guard (spec-440 dec-2, phase 1: LOUD, not fatal).
//
// A write to an RLS-gated tenant table only satisfies the `*_memex_isolation`
// policy when `app.memex_id` is set in the session — supplied by the rlsClient
// proxy from the `memexContext` ALS store. A code path that writes such a table
// with NO active `runWithMemexId(memexId, …)` on its async stack is rejected by
// Postgres under the non-owner `memex_app` runtime role (prod) — and that
// rejection is often swallowed by best-effort `try/catch`, so the only symptom
// is missing data days later (the spec-436 empty-workspace class).
//
// This guard makes that class LOUD at the moment it happens: when a context-less
// write targets a gated table AND the runtime is actually subject to RLS, it
// emits a WARN (Cloud Run + the std-14 `rls` domain log) and bumps a metric. It
// does NOT throw — phase 1 observes so we can audit callers from the signal
// before phase 2 (mutate() throwing, dec-2). Catching raw `db.insert`/`db.update`
// as well as mutate() is exactly why it lives at the proxy boundary, not in
// mutate() (which never sees the raw SQL).
//
// ROLE-AWARE by design: the guard fires ONLY when the runtime connection is
// RLS-subject (a non-owner, NOBYPASSRLS role — prod's `memex_app`, and the
// restricted-role test harness of dec-1). Under the owner role (dev, the default
// vitest suite, migrations, admin scripts) RLS is bypassed (std-36: ENABLE, NO
// FORCE), so a context-less gated write is harmless there and the guard stays
// silent — no false-positive firehose. connection.ts resolves the role once at
// boot and calls setRlsSubjectRuntime().

import { createDomainLogger } from "../observability/domain-logger.js";
import { recordRlsContextViolation } from "../observability/otel/index.js";
import { isRlsGatedTable } from "./rls-tables.js";

const log = createDomainLogger("rls");

// Whether THIS runtime's DB connection is subject to RLS (non-owner /
// NOBYPASSRLS). Defaults false so nothing fires until the role is positively
// confirmed RLS-subject — dev/test/migration owner connections stay silent.
let rlsSubjectRuntime = false;
// A test override (via __setRlsSubjectRuntimeForTests) latches this so the
// async boot probe in connection.ts can't clobber it mid-test (the probe runs
// at module load and may resolve at any point during a test run).
let explicitlySet = false;

/** Called once by connection.ts after it resolves the runtime role. A test
 * override wins — the boot probe never overwrites an explicitly-set value. */
export function setRlsSubjectRuntime(isSubject: boolean): void {
  if (explicitlySet) return;
  rlsSubjectRuntime = isSubject;
}

// Warn once per table per process so a hot write loop can't flood the logs; the
// metric still counts every occurrence. Reset between tests via the test hook.
const warnedTables = new Set<string>();

/**
 * The leading write target of a SQL statement, lower-cased, or null when the
 * statement is not an INSERT/UPDATE/DELETE (reads never violate a write policy).
 * Tolerates an optional `public.` schema qualifier and double-quoting, matching
 * the shape Drizzle's postgres-js driver emits (`insert into "documents" …`).
 */
export function writeTargetTable(sql: string): string | null {
  const m =
    /^\s*(?:insert\s+into|update(?:\s+only)?|delete\s+from)\s+(?:"?public"?\.)?"?([a-z_][a-z0-9_$]*)"?/i.exec(
      sql,
    );
  return m ? m[1]!.toLowerCase() : null;
}

/** True iff `sql` is a write to an RLS-gated table with no tenant in `ctx`. */
export function isContextlessGatedWrite(
  sql: string,
  ctx: { memexId?: string } | undefined,
): boolean {
  if (ctx?.memexId) return false; // tenant context present → RLS will pass
  const table = writeTargetTable(sql);
  return table !== null && isRlsGatedTable(table);
}

/** Emit the WARN + metric for one violation. Exported for direct testing. */
export function reportRlsContextViolation(table: string): void {
  // Metric on EVERY occurrence (no-op unless OTLP telemetry is configured).
  recordRlsContextViolation(table);
  // WARN once per table to keep logs readable. console.warn is the real severity
  // signal in Cloud Run (production observability, cl-30); the domain log is the
  // greppable std-14 trail.
  if (warnedTables.has(table)) return;
  warnedTables.add(table);
  const msg =
    `context-less write to RLS-gated table "${table}" — no app.memex_id in context. ` +
    `Under the memex_app runtime role this write is REJECTED by RLS and, if best-effort, ` +
    `silently drops data. Wrap the call in runWithMemexId(memexId, …). [spec-440]`;
  console.warn(`[rls] ${msg}`);
  log.block("guard", `context-less gated-table write: ${table}`, msg);
}

/**
 * The proxy hook. Cheap no-op unless the runtime is RLS-subject; only then does
 * it inspect the statement. Called from the rlsClient `unsafe` intercept for
 * every query, so the fast path (guard inactive, or a read, or context present)
 * must stay allocation-light.
 */
export function guardContextlessWrite(
  sql: string,
  ctx: { memexId?: string } | undefined,
): void {
  if (!rlsSubjectRuntime) return;
  if (!isContextlessGatedWrite(sql, ctx)) return;
  reportRlsContextViolation(writeTargetTable(sql)!);
}

/** Test-only: reset the module's activation + dedup state. */
export function __resetRlsGuardForTests(): void {
  rlsSubjectRuntime = false;
  explicitlySet = false;
  warnedTables.clear();
}

/** Test-only: force (and latch) the RLS-subject activation flag. */
export function __setRlsSubjectRuntimeForTests(isSubject: boolean): void {
  rlsSubjectRuntime = isSubject;
  explicitlySet = true;
}

/** Test-only: clear only the warn-dedup set, leaving activation untouched — so an
 * integration test under the real memex_app role can re-assert the WARN without
 * deactivating the guard the boot probe legitimately turned on. */
export function __clearRlsGuardWarnedTablesForTests(): void {
  warnedTables.clear();
}
