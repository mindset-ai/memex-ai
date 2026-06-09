import "dotenv/config";
import { AsyncLocalStorage } from "node:async_hooks";
import { drizzle } from "drizzle-orm/postgres-js";
import type { PostgresJsQueryResultHKT } from "drizzle-orm/postgres-js";
import type { PgTransaction } from "drizzle-orm/pg-core";
import type { ExtractTablesWithRelations } from "drizzle-orm";
import postgres from "postgres";
import * as schema from "./schema.js";

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  throw new Error("DATABASE_URL environment variable is required");
}

// Cloud SQL socket path (e.g. /cloudsql/project:region:instance)
const socketPath = process.env.CLOUD_SQL_SOCKET;

// Connection budget (2026-06-04 prod incident): prod Cloud SQL is db-f1-micro
// with max_connections=25 (~22 usable after superuser-reserved slots). The
// postgres-js DEFAULTS are max:10 per pool and idle_timeout:0 (idle
// connections are NEVER closed), so three Cloud Run instances at full pool +
// one relay LISTEN each (spec-156) is 33 — over budget before deploy overlap
// even starts, and revision churn (old instances pinned by long-lived SSE
// streams) made it worse. Cap the pool and reap idles so the steady-state
// budget is 3 × (5 + 1 LISTEN) = 18, and deploy-overlap pressure self-heals
// as idle connections close. Overridable per-env via DB_POOL_MAX (e.g. local
// dev and tests, where a single process wants more parallelism).
const poolMax = Number(process.env.DB_POOL_MAX ?? 5);
const poolOptions = {
  max: poolMax,
  // Seconds an idle connection lingers before being closed. Keeps drained
  // revisions from squatting on slots they'll never use again.
  idle_timeout: 60,
  // Proactively recycle long-lived connections (seconds) so slot usage stays
  // observable and Cloud SQL maintenance reconnects are exercised regularly.
  max_lifetime: 60 * 30,
} as const;

const client = socketPath
  ? postgres(connectionString, { host: socketPath, ...poolOptions })
  : postgres(connectionString, poolOptions);

// ── Per-query RLS tenant injection (spec-199 ac-13–ac-17) ────────────────────
//
// ALS carries the request-scoped memexId. Session middleware sets it via
// runWithMemexId. The rlsClient proxy reads it at every query call-site and
// prepends `set_config('app.memex_id', $1, true)` in a per-query
// micro-transaction — no changes to service functions required.
//
// Why per-query (not per-request)?  A per-request wrapper would hold a pool
// connection for the entire request lifetime (including Anthropic/Postmark I/O),
// violating the connection budget documented above.  Per-query micro-transactions
// hold a connection for milliseconds; each BEGIN/set_config/query/COMMIT is
// ≈3 extra ms but scales correctly at pool max=5.

interface MemexRequestContext {
  memexId: string;
}

export const memexContext = new AsyncLocalStorage<MemexRequestContext>();

/**
 * Set the request-scoped memexId in the ALS context for the duration of fn.
 * Every db.* call within fn's async subtree will automatically prepend
 * `set_config('app.memex_id', $1, true)` in its own micro-transaction so RLS
 * policies see the correct tenant on every query.
 *
 * When memexId is null/undefined (anonymous public read, no resolved tenant),
 * fn runs without an ALS context — the IS NOT NULL guard in each RLS policy
 * blocks cross-tenant reads on the restricted role, and the superuser role
 * bypasses RLS unconditionally.
 */
export function runWithMemexId(
  memexId: string | null | undefined,
  fn: () => Promise<void>,
): Promise<void> {
  if (!memexId) return fn();
  return memexContext.run({ memexId }, fn);
}

/**
 * Returns a thenable that executes `query` inside a per-query
 * BEGIN/set_config/COMMIT micro-transaction.  Supports both direct await
 * (returns row objects) and .values() chaining (returns row arrays — the form
 * Drizzle uses internally for SELECT field mapping).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeRlsQuery(pool: any, memexId: string, query: string, params: any[]) {
  const run = (useValues: boolean) =>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    pool.begin(async (txSql: any) => {
      await txSql.unsafe("SELECT set_config('app.memex_id', $1, true)", [memexId]);
      const q = txSql.unsafe(query, params);
      return useValues ? q.values() : q;
    });

  return {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    then(onfulfilled: any, onrejected: any) { return run(false).then(onfulfilled, onrejected); },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    catch(onrejected: any) { return run(false).catch(onrejected); },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    finally(onfinally: any) { return run(false).finally(onfinally); },
    values() {
      return {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        then(onfulfilled: any, onrejected: any) { return run(true).then(onfulfilled, onrejected); },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        catch(onrejected: any) { return run(true).catch(onrejected); },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        finally(onfinally: any) { return run(true).finally(onfinally); },
      };
    },
  };
}

/**
 * Proxy the postgres-js client to inject `set_config('app.memex_id')` when a
 * request context is active:
 *
 * - unsafe(q, p):  wraps in a per-query micro-transaction; .values() chaining
 *   is preserved for Drizzle's SELECT field mapper.
 * - begin(callback): prepends set_config to the caller's transaction so every
 *   query inside `db.transaction(tx => …)` inherits the GUC automatically.
 *
 * Only these two intercepts are needed: Drizzle routes ALL query execution
 * through client.unsafe() and all explicit transactions through client.begin().
 * Savepoints (nested tx.transaction()) use the transaction-scoped txSql which
 * already has the GUC set — they are never proxied.
 */
function createRlsClient(baseClient: postgres.Sql): postgres.Sql {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return new Proxy(baseClient as any, {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    get(target: any, prop: string | symbol) {
      if (prop === "unsafe") {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return function (query: string, params: any[] = []) {
          const ctx = memexContext.getStore();
          if (!ctx?.memexId) return target.unsafe(query, params);
          return makeRlsQuery(target, ctx.memexId, query, params);
        };
      }
      if (prop === "begin") {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return function (callback: (txSql: any) => Promise<any>) {
          const ctx = memexContext.getStore();
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          return target.begin(async (txSql: any) => {
            if (ctx?.memexId) {
              await txSql.unsafe("SELECT set_config('app.memex_id', $1, true)", [ctx.memexId]);
            }
            return callback(txSql);
          });
        };
      }
      return Reflect.get(target, prop, target);
    },
  }) as postgres.Sql;
}

const rlsClient = createRlsClient(client);

export const db = drizzle(rlsClient, { schema });

// The raw postgres-js pooled client. Exposed so the cross-instance bus relay
// (services/bus-relay.ts, spec-156) can issue fire-and-forget NOTIFY statements
// on the existing pool — a NOTIFY needs no dedicated socket. The relay's LISTEN
// side, by contrast, opens its OWN single connection and never touches this.
export const sqlClient = client;

// Shared connection-or-transaction type. Every service function takes this
// as an optional parameter so the same code runs standalone (using the db
// singleton) or inside `db.transaction(async (tx) => { ... })`, without
// any API divergence. Drizzle 0.39's tx callback parameter is a
// `PgTransaction`, not a `PostgresJsDatabase` (the db singleton adds a
// `$client` intersection that tx lacks), so the usable shape for service
// code is the union of both.
export type Db =
  | typeof db
  | PgTransaction<
      PostgresJsQueryResultHKT,
      typeof schema,
      ExtractTablesWithRelations<typeof schema>
    >;

// DI accessor (Batch 6 groundwork). New code should call `getDb()` rather
// than importing `db` directly so tests can swap the implementation via
// `setDb()`. Existing call sites keep using the raw `db` export —
// migration is opportunistic, not required.
let active: Db = db;
export function getDb(): Db {
  return active;
}
export function setDb(next: Db | null): void {
  active = next ?? db;
}

// Exposed so short-lived CLI tools (extractor, seed scripts) can shut down
// cleanly. Server process leaves this open for the lifetime of the server.
export async function closeDb(): Promise<void> {
  await client.end();
}
