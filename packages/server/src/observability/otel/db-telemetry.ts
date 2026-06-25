/**
 * The application's view of the database, as OpenTelemetry metrics.
 *
 * This module owns the "is the database healthy right now?" instruments and the
 * seam that feeds them: query latency, throughput, errors, total backends vs
 * max_connections, and pool utilisation. It deliberately emits NOTHING about the
 * database host itself — no CPU, disk, or memory — because the application
 * process cannot honestly measure the machine its database runs on. Those come
 * from infrastructure metrics and are stitched in by whatever dashboard reads
 * these series; this layer emits only the half it can actually observe.
 *
 * It is out-of-band by construction: nothing here writes to the database it
 * observes. Query metrics are recorded in-process by timing the existing query
 * path, and the backends probe is a read-only SELECT. So the signal survives the
 * very saturation it's there to report on.
 *
 * Label hygiene: the only metric label is the normalised SQL operation (a
 * bounded set of verbs). No tenant id, user id, IP, token, or query literal ever
 * becomes a label — that's both a privacy rule and a guard against unbounded
 * label cardinality blowing up the metrics backend.
 */
import type { Meter } from "@opentelemetry/api";

/** Every metric this layer emits. Centralised so a test can assert the whole
 * set is application-view only (no host CPU / disk / memory). */
export const DB_METRIC_NAMES = {
  queryDuration: "memex.db.query.duration",
  queryCount: "memex.db.query.count",
  queryErrors: "memex.db.query.errors",
  backends: "memex.db.backends",
  maxConnections: "memex.db.max_connections",
  poolInFlight: "memex.db.pool.in_flight",
  poolUtilisation: "memex.db.pool.utilisation",
} as const;

/** The sole metric-label key. Its value is a normalised verb, never raw SQL. */
export const DB_OPERATION_ATTR = "db.operation";

/** Latency histogram buckets (ms) — dense where database queries actually live,
 * so percentiles derived in the backend are meaningful. */
const LATENCY_BUCKETS_MS = [
  1, 2, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000,
];

/** Bounded set of SQL verbs we label with. Anything else collapses to OTHER so
 * a hostile or exotic statement can never explode label cardinality. */
const KNOWN_OPS = new Set([
  "SELECT", "INSERT", "UPDATE", "DELETE", "WITH", "BEGIN", "COMMIT",
  "ROLLBACK", "SET", "CREATE", "DROP", "ALTER", "TRUNCATE", "EXPLAIN",
  "SAVEPOINT", "RELEASE", "SHOW", "DO", "COPY", "VACUUM", "ANALYZE",
  "GRANT", "REVOKE", "LISTEN", "NOTIFY", "UNLISTEN",
]);

/**
 * Reduce a SQL string to its leading operation verb (uppercased), skipping
 * leading line / block comments and whitespace. Returns "OTHER" for anything
 * outside the known set. This is the only thing derived from statement text, and
 * it carries no literals, identifiers, or other sensitive data.
 */
export function normaliseOp(sql: string): string {
  if (typeof sql !== "string") return "OTHER";
  // Strip leading -- line comments and /* */ block comments, then whitespace.
  const stripped = sql.replace(
    /^(\s*(--[^\n]*\n|\/\*[\s\S]*?\*\/))*\s*/,
    "",
  );
  const match = /^([a-zA-Z]+)/.exec(stripped);
  const verb = match?.[1]?.toUpperCase();
  return verb && KNOWN_OPS.has(verb) ? verb : "OTHER";
}

/** Query-metric instruments plus the shared in-flight counter the pool gauge
 * reads. Created against one Meter so all share a provider / exporter. */
export interface DbInstruments {
  /** Record one completed logical query. */
  recordQuery(op: string, durationMs: number, status: "ok" | "error"): void;
  /** Current count of in-flight instrumented queries (for pool utilisation). */
  getInFlight(): number;
  /** Internal — bump / drop the in-flight counter around a query. */
  enter(): void;
  leave(): void;
}

export function createDbInstruments(meter: Meter): DbInstruments {
  const duration = meter.createHistogram(DB_METRIC_NAMES.queryDuration, {
    unit: "ms",
    description: "Database query latency (as observed by the application).",
    advice: { explicitBucketBoundaries: LATENCY_BUCKETS_MS },
  });
  const count = meter.createCounter(DB_METRIC_NAMES.queryCount, {
    description: "Database queries executed (throughput).",
  });
  const errors = meter.createCounter(DB_METRIC_NAMES.queryErrors, {
    description: "Database queries that errored or timed out.",
  });

  let inFlight = 0;

  return {
    recordQuery(op, durationMs, status) {
      const attrs = { [DB_OPERATION_ATTR]: op };
      duration.record(durationMs, attrs);
      count.add(1, attrs);
      if (status === "error") errors.add(1, attrs);
    },
    getInFlight: () => inFlight,
    enter: () => {
      inFlight += 1;
    },
    leave: () => {
      inFlight -= 1;
    },
  };
}

/**
 * The minimal postgres-js surface Drizzle's postgres-js driver actually drives:
 * every query goes through `client.unsafe(sql, params)`, consumed by either
 * `await` (row objects) or `.values()` (row arrays). We intercept exactly that.
 */
interface UnsafeClient {
  unsafe(query: string, params?: unknown[]): unknown;
}

/** A thenable that also exposes `.values()` — the shape `unsafe()` returns. */
interface QueryThenable {
  then(onF?: ((v: unknown) => unknown) | null, onR?: ((e: unknown) => unknown) | null): unknown;
  catch?(onR?: ((e: unknown) => unknown) | null): unknown;
  finally?(onF?: (() => void) | null): unknown;
  values(): unknown;
}

/**
 * Wrap one `unsafe()` result so the query is timed exactly once, on whichever
 * consumption path Drizzle takes (`await` or `.values()`). The connection layer
 * already wraps each query in a per-query micro-transaction (for row-level
 * security); this mirrors that thenable shape so result shape and `.values()`
 * chaining are preserved and only timing is added around the edges.
 */
function timeQuery(
  inner: unknown,
  op: string,
  instruments: DbInstruments,
): QueryThenable {
  let started = false;
  let settled = false;
  let start = 0;

  const finish = (status: "ok" | "error"): void => {
    if (settled) return;
    settled = true;
    instruments.leave();
    instruments.recordQuery(op, performance.now() - start, status);
  };

  // Only meter a query that's actually consumed; adopt the inner thenable so
  // execution happens exactly once on the chosen path.
  const measure = (p: unknown): Promise<unknown> => {
    if (!started) {
      started = true;
      start = performance.now();
      instruments.enter();
    }
    return Promise.resolve(p as PromiseLike<unknown>).then(
      (v) => {
        finish("ok");
        return v;
      },
      (e) => {
        finish("error");
        throw e;
      },
    );
  };

  const asThenable = inner as QueryThenable;
  return {
    then: (onF, onR) => measure(inner).then(onF ?? undefined, onR ?? undefined),
    catch: (onR) => measure(inner).catch(onR ?? undefined),
    finally: (onF) => measure(inner).finally(onF ?? undefined),
    values: () => {
      const valuesInner = asThenable.values();
      return {
        then: (onF: ((v: unknown) => unknown) | null = null, onR: ((e: unknown) => unknown) | null = null) =>
          measure(valuesInner).then(onF ?? undefined, onR ?? undefined),
        catch: (onR: ((e: unknown) => unknown) | null = null) =>
          measure(valuesInner).catch(onR ?? undefined),
        finally: (onF: (() => void) | null = null) =>
          measure(valuesInner).finally(onF ?? undefined),
      };
    },
  };
}

/**
 * Compose query instrumentation OVER an existing postgres-js client (typically
 * the row-level-security proxy from the connection layer). A get-trap proxy
 * intercepts `unsafe` and leaves everything else — including the callable
 * tagged-template form and `begin` — untouched, so the security-sensitive query
 * seam is unchanged; we only time what passes through it.
 */
export function instrumentSqlClient<T extends object>(
  base: T,
  instruments: DbInstruments,
): T {
  return new Proxy(base, {
    get(target, prop, receiver) {
      if (prop === "unsafe") {
        return (query: string, params: unknown[] = []) => {
          const op = normaliseOp(query);
          const inner = (target as unknown as UnsafeClient).unsafe(query, params);
          return timeQuery(inner, op, instruments);
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  });
}

/** Minimal read-only client surface the probe needs. */
export interface ProbeClient {
  unsafe(query: string): Promise<Array<Record<string, unknown>>>;
}

/** The out-of-band probe: a single cheap, read-only statement. Reads total
 * backends across the instance and the configured ceiling in one round-trip. */
export const BACKENDS_PROBE_SQL =
  "SELECT (SELECT count(*) FROM pg_stat_activity)::int AS backends, " +
  "current_setting('max_connections')::int AS max_connections";

export interface DbGaugeDeps {
  /** Raw (non-RLS) pooled client for the read-only probe. */
  readonly sqlClient: ProbeClient;
  /** Reads the live in-flight query count for pool utilisation. */
  readonly getInFlight: () => number;
  /** Pool size — the utilisation denominator. */
  readonly poolMax: number;
  /** Optional sink for probe errors (defaults to a single warn line). */
  readonly onProbeError?: (err: unknown) => void;
}

/**
 * Register the health observable gauges. One batch callback runs per collection
 * (on the export cadence): it reads the in-flight count (no database access) and
 * runs the read-only backends probe (one SELECT). If the probe fails it skips
 * the database-derived gauges for that tick and never throws — the monitor must
 * not die with the database it's watching.
 */
export function registerDbGauges(meter: Meter, deps: DbGaugeDeps): void {
  const backends = meter.createObservableGauge(DB_METRIC_NAMES.backends, {
    description: "Total Postgres backends across the instance.",
  });
  const maxConnections = meter.createObservableGauge(
    DB_METRIC_NAMES.maxConnections,
    { description: "Configured max_connections ceiling." },
  );
  const poolInFlight = meter.createObservableGauge(
    DB_METRIC_NAMES.poolInFlight,
    { description: "In-flight queries on the application pool." },
  );
  const poolUtilisation = meter.createObservableGauge(
    DB_METRIC_NAMES.poolUtilisation,
    { description: "Application pool utilisation (in-flight / pool max)." },
  );

  meter.addBatchObservableCallback(
    async (result) => {
      // Pool gauges need no database access — always observable, even under
      // saturation.
      const inFlight = deps.getInFlight();
      result.observe(poolInFlight, inFlight);
      result.observe(
        poolUtilisation,
        deps.poolMax > 0 ? inFlight / deps.poolMax : 0,
      );

      try {
        const rows = await deps.sqlClient.unsafe(BACKENDS_PROBE_SQL);
        const row = rows?.[0];
        if (row) {
          result.observe(backends, Number(row.backends));
          result.observe(maxConnections, Number(row.max_connections));
        }
      } catch (err) {
        // Resilient: skip the database-derived gauges this tick, never throw.
        (deps.onProbeError ?? defaultProbeError)(err);
      }
    },
    [backends, maxConnections, poolInFlight, poolUtilisation],
  );
}

function defaultProbeError(err: unknown): void {
  console.warn("[db-telemetry] backends probe failed (skipping tick):", err);
}
