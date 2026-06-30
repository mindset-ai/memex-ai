import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import { tagAc } from "@memex-ai-ac/vitest";
import {
  AggregationTemporality,
  InMemoryMetricExporter,
  type MetricReader,
  MeterProvider,
  PeriodicExportingMetricReader,
} from "@opentelemetry/sdk-metrics";
import {
  DB_METRIC_NAMES,
  createDbInstruments,
  registerDbGauges,
} from "./db-telemetry.js";

const AC6 = "mindset-prod/memex-building-itself/specs/spec-412/acs/ac-6";
const AC7 = "mindset-prod/memex-building-itself/specs/spec-412/acs/ac-7";
const AC8 = "mindset-prod/memex-building-itself/specs/spec-412/acs/ac-8";
const AC10 = "mindset-prod/memex-building-itself/specs/spec-412/acs/ac-10";
const AC11 = "mindset-prod/memex-building-itself/specs/spec-412/acs/ac-11";

const OTEL_DIR = dirname(fileURLToPath(import.meta.url));

function listFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFiles(full));
    else out.push(full);
  }
  return out;
}

const sourceFiles = listFiles(OTEL_DIR).filter(
  (f) => f.endsWith(".ts") && !f.endsWith(".test.ts"),
);

describe("spec-412 emission boundary — app's view only (ac-6, ac-10)", () => {
  it("the metric registry names no database-instance CPU / disk / memory", () => {
    tagAc(AC6);
    tagAc(AC10);
    for (const name of Object.values(DB_METRIC_NAMES)) {
      expect(name.startsWith("memex.db.")).toBe(true);
      expect(name).not.toMatch(/cpu|disk|memory|mem\b/i);
    }
  });

  it("the EMITTED metric set is app-view only — no instance series leak", async () => {
    tagAc(AC6);
    tagAc(AC10);
    const exporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
    const reader: MetricReader = new PeriodicExportingMetricReader({
      exporter,
      exportIntervalMillis: 2_147_483_647,
    });
    const provider = new MeterProvider({ readers: [reader] });
    const meter = provider.getMeter("test");
    const instruments = createDbInstruments(meter);

    // Exercise query metrics + gauges, then read back EVERYTHING emitted.
    instruments.recordQuery("SELECT", 3, "ok");
    registerDbGauges(meter, {
      sqlClient: {
        unsafe: async () => [{ backends: 4, max_connections: 50 }],
      },
      getInFlight: () => 1,
      poolMax: 5,
    });

    const { resourceMetrics } = await reader.collect();
    const emitted = resourceMetrics.scopeMetrics.flatMap((s) =>
      s.metrics.map((m) => m.descriptor.name),
    );
    expect(emitted.length).toBeGreaterThan(0);
    const known = new Set(Object.values(DB_METRIC_NAMES));
    for (const name of emitted) {
      expect(name).not.toMatch(/cpu|disk|memory|mem\b/i);
      expect(known.has(name)).toBe(true); // nothing outside the app-view registry
    }
    await provider.shutdown();
  });
});

describe("spec-412 sensor-only boundary — no alarm logic here (ac-8)", () => {
  it("the OTEL source emits signals but encodes no alert/threshold/Slack routing", () => {
    tagAc(AC8);
    for (const file of sourceFiles) {
      const body = readFileSync(file, "utf8");
      // Strip comments so prose like "spec-332's saturation alarm" doesn't trip
      // the guard — we care about CODE, not the doc explaining the boundary.
      const code = body
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^\s*\/\/.*$/gm, "")
        .replace(/^\s*\*.*$/gm, "");
      expect(code).not.toMatch(/slack/i);
      expect(code).not.toMatch(/\bwebhook\b/i);
      expect(code).not.toMatch(/threshold/i);
      expect(code).not.toMatch(/alert(ing)?\b/i);
    }
  });
});

describe("spec-412 fair-code boundary — no EE markers (ac-11)", () => {
  it("no file in this layer carries a .ee. filename or .ee/ dir marker", () => {
    tagAc(AC11);
    const repoRoot = join(OTEL_DIR, "..", "..", "..", "..", "..");
    for (const file of listFiles(OTEL_DIR)) {
      const rel = relative(repoRoot, file);
      expect(rel).not.toMatch(/\.ee\./); // .ee. filename marker
      expect(rel).not.toMatch(/(^|\/)\.ee(\/|$)/); // .ee/ dirname marker
    }
  });

  it("ships no Prometheus/Grafana dashboard pack (deferred to product packaging)", () => {
    tagAc(AC7);
    for (const file of listFiles(OTEL_DIR)) {
      expect(file).not.toMatch(/dashboard|grafana|prometheus/i);
    }
  });
});
