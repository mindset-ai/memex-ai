import "dotenv/config";
import { AsyncLocalStorage } from "node:async_hooks";
import { drizzle } from "drizzle-orm/postgres-js";
import type { PostgresJsQueryResultHKT } from "drizzle-orm/postgres-js";
import type { PgTransaction } from "drizzle-orm/pg-core";
import type { ExtractTablesWithRelations } from "drizzle-orm";
import postgres from "postgres";
import * as schema from "./schema.js";
import { instrumentSqlClientIfEnabled } from "../observability/otel/index.js";
import { guardContextlessWrite, setRlsSubjectRuntime } from "./rls-context-guard.js";

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

// Resolve ONCE whether this runtime's connection is subject to RLS — a non-owner
// role with neither SUPERUSER nor BYPASSRLS (prod's `memex_app`). The
// tenant-context guard (rls-context-guard.ts, spec-440) fires only when RLS is
// actually enforced, so owner-connection paths (dev, the default test suite,
// migrations, admin scripts) that bypass RLS (std-36: ENABLE, NO FORCE) stay
// silent — no false positives. Fire-and-forget: the guard defaults inactive
// until this resolves, and a probe failure simply leaves it inactive.
void (async () => {
  try {
    const rows = (await client`
      SELECT NOT (rolsuper OR rolbypassrls) AS subject
      FROM pg_roles
      WHERE rolname = current_user
    `) as unknown as Array<{ subject: boolean }>;
    setRlsSubjectRuntime(rows[0]?.subject === true);
  } catch {
    // Leave the guard inactive if the runtime role can't be determined.
  }
})();

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

// The request-scoped RLS identity. Either field may be set independently:
//   memexId — the tenant in context (the original spec-199 isolation key).
//   userId  — the acting user, for cross-memex user-scoped reads (spec-303
//             journey-state). Lets a query see the user's OWN rows across every
//             memex via the additive `*_owner_visibility` SELECT policies
//             (migration 0098), without pinning to a single app.memex_id. Reads
//             only: the FOR ALL memex_isolation policy still gates every write.
interface RlsRequestContext {
  memexId?: string;
  userId?: string;
}

export const memexContext = new AsyncLocalStorage<RlsRequestContext>();

// ── RLS-seam query types (spec-356 cq-4) ─────────────────────────────────────
// The seam below proxies the postgres-js driver. Before spec-356 it carried 15
// `any`s + eslint-disables for a linter that did not exist (see std-36: this
// seam is security-load-bearing — it injects the tenant GUC on every query, so
// loose typing here is the worst place for it). These aliases pin the seam to
// the driver's own published types: a tagged-template-or-`unsafe` SQL handle
// (`Sql`), its transaction-scoped form (`TransactionSql`), and the parameter
// array `unsafe()` accepts.
type SqlClient = postgres.Sql;
type TxClient = postgres.TransactionSql;
type QueryParams = postgres.ParameterOrJSON<never>[];

/** Emit `set_config(...)` for whichever RLS GUCs the context carries. Absent
 * GUCs are simply not set, so the matching policy sees NULL for that GUC and
 * contributes nothing — each policy is additive per GUC. */
async function applyRlsGucs(txSql: TxClient, ctx: RlsRequestContext): Promise<void> {
  if (ctx.memexId) {
    await txSql.unsafe("SELECT set_config('app.memex_id', $1, true)", [ctx.memexId]);
  }
  if (ctx.userId) {
    await txSql.unsafe("SELECT set_config('app.user_id', $1, true)", [ctx.userId]);
  }
}

/**
 * Set the request-scoped memexId in the ALS context for the duration of fn.
 * Every db.* call within fn's async subtree will automatically prepend
 * `set_config('app.memex_id', $1, true)` in its own micro-transaction so RLS
 * policies see the correct tenant on every query.
 *
 * When memexId is null/undefined (anonymous public read, no resolved tenant),
 * fn runs without an ALS context — the IS NOT NULL guard in each RLS policy
 * blocks cross-tenant reads on the restricted runtime role `memex_app`.
 *
 * NOTE (spec-257 dec-1 / std-36): the OWNER role bypasses RLS only because the
 * tenant tables are `ENABLE` + `NO FORCE` (migration 0093) — NOT via a BYPASSRLS
 * attribute. On Cloud SQL `postgres` is not a real superuser and has neither
 * `rolsuper` nor `rolbypassrls` (verified prod+int 2026-06-11); under the old
 * `FORCE` it was filtered to zero rows, which caused the 2026-06-10 emission and
 * 2026-06-11 What's New outages. The runtime connects as the non-owner `memex_app`
 * and is always subject to RLS; only owner-role paths (migrations, deploy/admin
 * scripts) bypass.
 */
export function runWithMemexId<T>(
  memexId: string | null | undefined,
  fn: () => Promise<T>,
): Promise<T> {
  if (!memexId) return fn();
  const existing = memexContext.getStore();
  return memexContext.run({ ...existing, memexId }, fn);
}

/**
 * Set the request-scoped acting userId for cross-memex, user-scoped reads
 * (spec-303 journey-state). Every db.* call within fn's async subtree prepends
 * `set_config('app.user_id', $1, true)`, so the additive `*_owner_visibility`
 * SELECT policies (migration 0098) make the user's OWN authored rows visible
 * across every memex — without setting app.memex_id (there is no single tenant
 * for a "what has this user done anywhere" query).
 *
 * Strictly additive AND read-only: the new policies are FOR SELECT, so they
 * widen visibility ONLY to rows the acting user authored (created_by_user_id /
 * actor_user_id = userId) — always safe to show their author — and cannot widen
 * INSERT/UPDATE/DELETE, which the untouched FOR ALL memex_isolation policy still
 * gates. Any path that does not call this leaves app.user_id unset, so behaviour
 * there is byte-for-byte the same. Merges with any active memexId, not clobber.
 */
export function runWithUserId<T>(
  userId: string | null | undefined,
  fn: () => Promise<T>,
): Promise<T> {
  if (!userId) return fn();
  const existing = memexContext.getStore();
  return memexContext.run({ ...existing, userId }, fn);
}

/**
 * Returns a thenable that executes `query` inside a per-query
 * BEGIN/set_config/COMMIT micro-transaction.  Supports both direct await
 * (returns row objects) and .values() chaining (returns row arrays — the form
 * Drizzle uses internally for SELECT field mapping).
 */
function makeRlsQuery(
  pool: SqlClient,
  ctx: RlsRequestContext,
  query: string,
  params: QueryParams,
) {
  // The executed query resolves to driver rows; row objects vs row arrays
  // (`.values()`) are the same data in two shapes, so `unknown` is the honest
  // payload type here — Drizzle re-types the result at its own call site.
  const run = (useValues: boolean): Promise<unknown> =>
    pool.begin(async (txSql: TxClient) => {
      await applyRlsGucs(txSql, ctx);
      const q = txSql.unsafe(query, params);
      return useValues ? q.values() : q;
    });

  return {
    then: <R1 = unknown, R2 = never>(
      onfulfilled?: ((value: unknown) => R1 | PromiseLike<R1>) | null,
      onrejected?: ((reason: unknown) => R2 | PromiseLike<R2>) | null,
    ) => run(false).then(onfulfilled, onrejected),
    catch: <R = never>(onrejected?: ((reason: unknown) => R | PromiseLike<R>) | null) =>
      run(false).catch(onrejected),
    finally: (onfinally?: (() => void) | null) => run(false).finally(onfinally),
    values() {
      return {
        then: <R1 = unknown, R2 = never>(
          onfulfilled?: ((value: unknown) => R1 | PromiseLike<R1>) | null,
          onrejected?: ((reason: unknown) => R2 | PromiseLike<R2>) | null,
        ) => run(true).then(onfulfilled, onrejected),
        catch: <R = never>(onrejected?: ((reason: unknown) => R | PromiseLike<R>) | null) =>
          run(true).catch(onrejected),
        finally: (onfinally?: (() => void) | null) => run(true).finally(onfinally),
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
function createRlsClient(baseClient: SqlClient): SqlClient {
  return new Proxy(baseClient, {
    get(target: SqlClient, prop: string | symbol, receiver: unknown) {
      if (prop === "unsafe") {
        return (query: string, params: QueryParams = []) => {
          const ctx = memexContext.getStore();
          // spec-440: make a context-less write to an RLS-gated table LOUD
          // (warn + metric) before it silently fails RLS under memex_app. No-op
          // unless the runtime is RLS-subject; cheap for reads / context-present.
          guardContextlessWrite(query, ctx);
          if (!ctx?.memexId && !ctx?.userId) return target.unsafe(query, params);
          return makeRlsQuery(target, ctx, query, params);
        };
      }
      if (prop === "begin") {
        return (callback: (txSql: TxClient) => Promise<unknown>) => {
          const ctx = memexContext.getStore();
          return target.begin(async (txSql: TxClient) => {
            if (ctx) await applyRlsGucs(txSql, ctx);
            return callback(txSql);
          });
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  }) as SqlClient;
}

const rlsClient = createRlsClient(client);

// Compose OpenTelemetry query instrumentation over the RLS proxy when database
// telemetry is enabled (an OTLP endpoint is configured). When disabled — local
// dev and the test suite — this returns rlsClient UNCHANGED, so query behaviour
// and overhead are byte-for-byte identical to before. The instrumentation only
// times queries; it never alters results or the RLS micro-transaction seam.
const instrumentedClient = instrumentSqlClientIfEnabled(rlsClient);

export const db = drizzle(instrumentedClient, { schema });

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
