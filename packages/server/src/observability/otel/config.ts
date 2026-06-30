/**
 * Configuration for the database-observability layer.
 *
 * The whole "plug it into your own stack" promise bottoms out here: the
 * telemetry is driven entirely by environment configuration, with no code path
 * differing between a managed backend and a self-hosted one. You redirect the
 * database metrics into your own Grafana / Datadog by setting one variable —
 * `OTEL_EXPORTER_OTLP_ENDPOINT` — and nothing else.
 *
 * Enablement is presence-driven: telemetry is ON exactly when an OTLP endpoint
 * is configured. Local dev and the test suite leave it unset, so the
 * instrumentation is a zero-overhead no-op there (the connection seam returns
 * the un-wrapped client).
 *
 * The app exports OTLP directly — there is no separate collector process to
 * run. Pointing the endpoint at a collector later is purely a config change.
 */

/** Default export / probe cadence (ms). ~20s trades freshness against the
 * series volume a metrics backend has to store. */
export const DEFAULT_EXPORT_INTERVAL_MS = 20_000;

/** Default postgres-js pool size — mirrors the value in db/connection.ts
 * (`DB_POOL_MAX`); it is the denominator for pool utilisation. */
export const DEFAULT_POOL_MAX = 5;

export interface OtelConfig {
  /** True iff an OTLP endpoint is configured. The single on/off switch. */
  readonly enabled: boolean;
  /** The OTLP base endpoint (`OTEL_EXPORTER_OTLP_ENDPOINT`), if set. */
  readonly otlpEndpoint?: string;
  /** Export + probe cadence in ms (`MEMEX_OTEL_EXPORT_INTERVAL_MS`). */
  readonly exportIntervalMs: number;
  /** Pool denominator for utilisation (`DB_POOL_MAX`). */
  readonly poolMax: number;
}

type Env = Record<string, string | undefined>;

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

/**
 * Read the config from the environment (defaults to `process.env`).
 *
 * Pure and side-effect-free so it's trivially testable: pass an env object, get
 * a config. The presence of `OTEL_EXPORTER_OTLP_ENDPOINT` is the enable signal,
 * which is what makes both enabling and redirecting config-only.
 */
export function readOtelConfig(env: Env = process.env): OtelConfig {
  const rawEndpoint = env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim();
  const otlpEndpoint = rawEndpoint ? rawEndpoint : undefined;
  return {
    enabled: otlpEndpoint !== undefined,
    otlpEndpoint,
    exportIntervalMs: parsePositiveInt(
      env.MEMEX_OTEL_EXPORT_INTERVAL_MS,
      DEFAULT_EXPORT_INTERVAL_MS,
    ),
    poolMax: parsePositiveInt(env.DB_POOL_MAX, DEFAULT_POOL_MAX),
  };
}

/**
 * Derive the OTLP metrics URL from the configured base endpoint. The OTLP/HTTP
 * spec puts metrics at `<endpoint>/v1/metrics`; honour a base that already
 * carries the path. This keeps a redirect a single-variable change.
 */
export function deriveMetricsUrl(endpoint: string): string {
  const trimmed = endpoint.replace(/\/+$/, "");
  return trimmed.endsWith("/v1/metrics") ? trimmed : `${trimmed}/v1/metrics`;
}
