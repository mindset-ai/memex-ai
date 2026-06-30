/**
 * MeterProvider + exporter construction.
 *
 * The exporter is chosen by config alone:
 *   - enabled (OTLP endpoint set) → an OTLP/HTTP metric exporter pushing
 *     directly to the configured backend, whether that's a managed metrics
 *     service or a self-hoster's own collector / Grafana / Datadog. No separate
 *     collector process.
 *   - disabled → no reader; the provider still hands out instruments that
 *     record into the void, so call sites never have to branch on enablement.
 *
 * The instrumentation is the durable part; the backend behind the OTLP endpoint
 * is a config-swappable detail.
 */
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import {
  AggregationTemporality,
  type PushMetricExporter,
  MeterProvider,
  PeriodicExportingMetricReader,
} from "@opentelemetry/sdk-metrics";
import { ATTR_SERVICE_NAME } from "@opentelemetry/semantic-conventions";
import { type OtelConfig, deriveMetricsUrl } from "./config.js";

/** OTEL resource identifying these series as the server's database telemetry. */
export function dbTelemetryResource() {
  return resourceFromAttributes({ [ATTR_SERVICE_NAME]: "memex-server" });
}

/**
 * Build the metric exporter for a config, or `undefined` when telemetry is
 * disabled. Delta temporality suits counters / histograms pushed to a
 * time-series backend.
 *
 * Exposed (not inlined) so a test can assert the enabled path yields a real
 * OTLP exporter and the disabled path yields none — the empirical proof that
 * the OTLP target is driven by configuration.
 */
export function createMetricExporter(
  config: OtelConfig,
): PushMetricExporter | undefined {
  if (!config.enabled || config.otlpEndpoint === undefined) return undefined;
  return new OTLPMetricExporter({
    url: deriveMetricsUrl(config.otlpEndpoint),
    temporalityPreference: AggregationTemporality.DELTA,
  });
}

/**
 * Build a MeterProvider for a config. When enabled, a periodic reader drives
 * both the OTLP push and the observable-gauge probe on the same cadence.
 *
 * `exporterOverride` lets tests inject an in-memory exporter without touching
 * the network.
 */
export function buildMeterProvider(
  config: OtelConfig,
  exporterOverride?: PushMetricExporter,
): MeterProvider {
  const exporter = exporterOverride ?? createMetricExporter(config);
  const readers = exporter
    ? [
        new PeriodicExportingMetricReader({
          exporter,
          exportIntervalMillis: config.exportIntervalMs,
        }),
      ]
    : [];
  return new MeterProvider({ resource: dbTelemetryResource(), readers });
}
