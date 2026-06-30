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

/** Test-only: drop the singleton so a fresh config can be applied. */
export function __resetDbTelemetryForTests(): void {
  singleton = null;
}
