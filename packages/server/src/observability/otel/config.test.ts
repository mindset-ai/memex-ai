import { describe, it, expect } from "vitest";
import { tagAc } from "@memex-ai-ac/vitest";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";
import {
  DEFAULT_EXPORT_INTERVAL_MS,
  DEFAULT_POOL_MAX,
  deriveMetricsUrl,
  readOtelConfig,
} from "./config.js";
import { buildMeterProvider, createMetricExporter } from "./meter-provider.js";

const AC3 = "mindset-prod/memex-building-itself/specs/spec-412/acs/ac-3";
const AC7 = "mindset-prod/memex-building-itself/specs/spec-412/acs/ac-7";
const AC12 = "mindset-prod/memex-building-itself/specs/spec-412/acs/ac-12";

describe("spec-412 OTEL config — the telemetry is driven by configuration alone", () => {
  it("is DISABLED when no OTLP endpoint is configured (local/test default)", () => {
    tagAc(AC3);
    tagAc(AC12);
    const cfg = readOtelConfig({});
    expect(cfg.enabled).toBe(false);
    expect(cfg.otlpEndpoint).toBeUndefined();
    // Defaults still resolve so the disabled path is fully formed.
    expect(cfg.exportIntervalMs).toBe(DEFAULT_EXPORT_INTERVAL_MS);
    expect(cfg.poolMax).toBe(DEFAULT_POOL_MAX);
  });

  it("ENABLES purely from OTEL_EXPORTER_OTLP_ENDPOINT — no other code path (ac-12)", () => {
    tagAc(AC12);
    const cfg = readOtelConfig({
      OTEL_EXPORTER_OTLP_ENDPOINT: "https://collector.example.com:4318",
    });
    expect(cfg.enabled).toBe(true);
    expect(cfg.otlpEndpoint).toBe("https://collector.example.com:4318");
  });

  it("treats a blank/whitespace endpoint as unset (no accidental enable)", () => {
    tagAc(AC12);
    expect(readOtelConfig({ OTEL_EXPORTER_OTLP_ENDPOINT: "   " }).enabled).toBe(
      false,
    );
  });

  it("reads cadence + pool denominator from the environment", () => {
    tagAc(AC12);
    const cfg = readOtelConfig({
      OTEL_EXPORTER_OTLP_ENDPOINT: "http://x:4318",
      MEMEX_OTEL_EXPORT_INTERVAL_MS: "15000",
      DB_POOL_MAX: "8",
    });
    expect(cfg.exportIntervalMs).toBe(15000);
    expect(cfg.poolMax).toBe(8);
  });

  it("falls back to defaults on a non-positive / garbage cadence", () => {
    tagAc(AC12);
    expect(
      readOtelConfig({ MEMEX_OTEL_EXPORT_INTERVAL_MS: "nonsense" })
        .exportIntervalMs,
    ).toBe(DEFAULT_EXPORT_INTERVAL_MS);
    expect(
      readOtelConfig({ MEMEX_OTEL_EXPORT_INTERVAL_MS: "0" }).exportIntervalMs,
    ).toBe(DEFAULT_EXPORT_INTERVAL_MS);
  });

  describe("deriveMetricsUrl — redirect is a single-variable change (ac-3)", () => {
    it("appends the OTLP metrics path to a bare endpoint", () => {
      tagAc(AC3);
      expect(deriveMetricsUrl("https://collector:4318")).toBe(
        "https://collector:4318/v1/metrics",
      );
      expect(deriveMetricsUrl("https://collector:4318/")).toBe(
        "https://collector:4318/v1/metrics",
      );
    });

    it("respects an endpoint that already carries the path", () => {
      tagAc(AC3);
      expect(deriveMetricsUrl("https://collector:4318/v1/metrics")).toBe(
        "https://collector:4318/v1/metrics",
      );
    });
  });

  describe("exporter selection — backend chosen by config (ac-7)", () => {
    it("builds a real OTLP exporter when enabled", () => {
      tagAc(AC7);
      tagAc(AC3);
      const exporter = createMetricExporter(
        readOtelConfig({ OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector:4318" }),
      );
      expect(exporter).toBeInstanceOf(OTLPMetricExporter);
    });

    it("builds NO exporter when disabled (no backend, no overhead)", () => {
      tagAc(AC7);
      expect(createMetricExporter(readOtelConfig({}))).toBeUndefined();
    });

    it("redirecting the endpoint is config-only: same code, different target", async () => {
      tagAc(AC3);
      // Two different endpoints, identical code path → two providers, each with
      // an exporting reader. The only difference is the env value. That IS the
      // self-host redirect promise (no code change).
      const a = buildMeterProvider(
        readOtelConfig({ OTEL_EXPORTER_OTLP_ENDPOINT: "http://a:4318" }),
      );
      const b = buildMeterProvider(
        readOtelConfig({ OTEL_EXPORTER_OTLP_ENDPOINT: "http://b:4318" }),
      );
      expect(a).toBeDefined();
      expect(b).toBeDefined();
      await a.shutdown();
      await b.shutdown();
    });
  });
});
