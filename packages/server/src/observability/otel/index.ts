/**
 * Wiring for the database-observability layer.
 *
 * Two entry points, one singleton:
 *   - `instrumentSqlClientIfEnabled(base)` — called once from the connection
 *     layer at module load. When telemetry is disabled (no OTLP endpoint, i.e.
 *     local dev and tests) it returns the client UNCHANGED, so behaviour and
 *     overhead are identical to having no instrumentation at all. When enabled
 *     it composes query instrumentation over the client.
 *   - `startDbTelemetry()` — called once after the server boots, registering the
 *     backends / pool observable gauges on the same meter so the in-flight
 *     counter is shared with the query instrumentation.
 *
 * The singleton ties both to one MeterProvider / exporter built from config.
 */
import type { Counter } from "@opentelemetry/api";
import type { MeterProvider } from "@opentelemetry/sdk-metrics";
import { type OtelConfig, readOtelConfig } from "./config.js";
import {
  type DbInstruments,
  type ProbeClient,
  createDbInstruments,
  instrumentSqlClient,
  registerDbGauges,
} from "./db-telemetry.js";
import { buildMeterProvider } from "./meter-provider.js";

interface DbTelemetry {
  readonly provider: MeterProvider;
  readonly instruments: DbInstruments;
  readonly config: OtelConfig;
}

let singleton: DbTelemetry | null = null;

/** Build (once) the shared MeterProvider + instruments for the enabled path. */
function getDbTelemetry(config: OtelConfig): DbTelemetry {
  if (singleton) return singleton;
  const provider = buildMeterProvider(config);
  const meter = provider.getMeter("memex.db");
  singleton = { provider, instruments: createDbInstruments(meter), config };
  return singleton;
}

/**
 * Compose query instrumentation over `base` when telemetry is enabled; return
 * `base` unchanged otherwise. The enablement test is purely config (presence of
 * an OTLP endpoint), which is what makes the whole layer a config-only opt-in.
 */
export function instrumentSqlClientIfEnabled<T extends object>(
  base: T,
  config: OtelConfig = readOtelConfig(),
): T {
  if (!config.enabled) return base;
  return instrumentSqlClient(base, getDbTelemetry(config).instruments);
}

/**
 * Register the backends / pool observable gauges. No-op (returns null) when
 * telemetry is disabled. Returns the MeterProvider so the caller can keep a
 * handle (e.g. for shutdown).
 */
export function startDbTelemetry(
  deps: { sqlClient: ProbeClient },
  config: OtelConfig = readOtelConfig(),
): MeterProvider | null {
  if (!config.enabled) return null;
  const { provider, instruments } = getDbTelemetry(config);
  registerDbGauges(provider.getMeter("memex.db"), {
    sqlClient: deps.sqlClient,
    getInFlight: instruments.getInFlight,
    poolMax: config.poolMax,
  });
  return provider;
}

// ── RLS tenant-context guard metric (spec-440 dec-2) ─────────────────────────
// A correctness counter, not a DB-health signal, so it rides the shared
// MeterProvider on its OWN meter ("memex.rls") rather than db-telemetry's
// instruments. Lazily created on first violation; a no-op when telemetry is
// disabled (local dev + tests), so the guard's console.warn is the only signal
// there — which is exactly what makes the class visible without an OTLP backend.
let rlsViolationCounter: Counter | null = null;

/**
 * Record one RLS tenant-context violation (a write to an RLS-gated table with no
 * `app.memex_id` in context). No-op unless OTLP telemetry is configured. The
 * `table` label is drawn from the fixed RLS_TENANT_TABLES set, so it is bounded /
 * low-cardinality and safe as a metric label (never a tenant or user id).
 */
export function recordRlsContextViolation(
  table: string,
  config: OtelConfig = readOtelConfig(),
): void {
  if (!config.enabled) return;
  if (!rlsViolationCounter) {
    rlsViolationCounter = getDbTelemetry(config).provider
      .getMeter("memex.rls")
      .createCounter("memex.db.rls.context_violations", {
        description:
          "Writes to an RLS-gated table attempted with no app.memex_id in context.",
      });
  }
  rlsViolationCounter.add(1, { table });
}

/** Test-only: drop the singleton so a fresh config can be applied. */
export function __resetDbTelemetryForTests(): void {
  singleton = null;
  rlsViolationCounter = null;
}
