import { afterAll, describe, expect, it } from "vitest";
import { tagAc } from "@memex-ai-ac/vitest";
import { drizzle } from "drizzle-orm/postgres-js";
import { sql } from "drizzle-orm";
import postgres from "postgres";
import {
  AggregationTemporality,
  type DataPoint,
  InMemoryMetricExporter,
  type MetricReader,
  MeterProvider,
  PeriodicExportingMetricReader,
} from "@opentelemetry/sdk-metrics";
import {
  BACKENDS_PROBE_SQL,
  DB_METRIC_NAMES,
  createDbInstruments,
  instrumentSqlClient,
  registerDbGauges,
} from "./db-telemetry.js";

const AC1 = "mindset-prod/memex-building-itself/specs/spec-412/acs/ac-1";
const AC2 = "mindset-prod/memex-building-itself/specs/spec-412/acs/ac-2";
const AC9 = "mindset-prod/memex-building-itself/specs/spec-412/acs/ac-9";

const DB_URL = process.env.DATABASE_URL as string;
const client = postgres(DB_URL, { max: 2 });

afterAll(async () => {
  await client.end({ timeout: 5 });
});

function meterCtx() {
  const exporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
  const reader: MetricReader = new PeriodicExportingMetricReader({
    exporter,
    exportIntervalMillis: 2_147_483_647,
  });
  const provider = new MeterProvider({ readers: [reader] });
  return { meter: provider.getMeter("test"), reader, provider };
}

async function collect(reader: MetricReader) {
  const { resourceMetrics } = await reader.collect();
  const out = new Map<string, DataPoint<unknown>[]>();
  for (const sm of resourceMetrics.scopeMetrics) {
    for (const m of sm.metrics) {
      out.set(m.descriptor.name, m.dataPoints as DataPoint<unknown>[]);
    }
  }
  return out;
}

describe("spec-412 query instrumentation over REAL postgres-js + Drizzle (ac-1)", () => {
  it("runs a real query unchanged and records latency + throughput", async () => {
    tagAc(AC1);
    const { meter, reader, provider } = meterCtx();
    const instruments = createDbInstruments(meter);
    const db = drizzle(instrumentSqlClient(client, instruments));

    // Real round-trip through the instrumented client — results must be intact.
    const rows = await db.execute(sql`select 1 as one, 'hi' as two`);
    expect(Number(rows[0]?.one)).toBe(1);
    expect(rows[0]?.two).toBe("hi");

    const metrics = await collect(reader);
    const count = metrics.get(DB_METRIC_NAMES.queryCount)?.[0];
    expect(Number(count?.value)).toBeGreaterThanOrEqual(1);
    const duration = metrics.get(DB_METRIC_NAMES.queryDuration)?.[0]?.value as
      | { count: number }
      | undefined;
    expect(duration?.count).toBeGreaterThanOrEqual(1);
    await provider.shutdown();
  });
});

describe("spec-412 backends probe — the first deliverable slice (ac-2, ac-9)", () => {
  it("emits total backends + max_connections from pg_stat_activity", async () => {
    tagAc(AC2);
    tagAc(AC9);
    const { meter, reader, provider } = meterCtx();
    const instruments = createDbInstruments(meter);
    registerDbGauges(meter, {
      sqlClient: client,
      getInFlight: instruments.getInFlight,
      poolMax: 5,
    });

    const metrics = await collect(reader);

    const backends = metrics.get(DB_METRIC_NAMES.backends)?.[0];
    expect(Number(backends?.value)).toBeGreaterThanOrEqual(1); // we are a backend

    const maxConn = metrics.get(DB_METRIC_NAMES.maxConnections)?.[0];
    expect(Number(maxConn?.value)).toBeGreaterThan(0);

    // Pool gauges are present too, regardless of DB state.
    expect(metrics.has(DB_METRIC_NAMES.poolUtilisation)).toBe(true);
    await provider.shutdown();
  });

  it("the probe is read-only — out-of-band by construction (ac-2)", () => {
    tagAc(AC2);
    expect(BACKENDS_PROBE_SQL.trimStart().toUpperCase().startsWith("SELECT")).toBe(
      true,
    );
    expect(BACKENDS_PROBE_SQL).not.toMatch(/\b(INSERT|UPDATE|DELETE|CREATE|DROP|ALTER)\b/i);
  });

  it("survives a probe failure: pool gauges still emit, backends skipped (ac-9)", async () => {
    tagAc(AC9);
    const { meter, reader, provider } = meterCtx();
    const instruments = createDbInstruments(meter);
    registerDbGauges(meter, {
      sqlClient: {
        unsafe: async () => {
          throw new Error("connection refused");
        },
      },
      getInFlight: instruments.getInFlight,
      poolMax: 5,
      onProbeError: () => {}, // silence the expected warn in the test
    });

    // collect() must resolve (the canary doesn't die with the DB).
    const metrics = await collect(reader);
    expect(metrics.has(DB_METRIC_NAMES.poolUtilisation)).toBe(true);
    expect(metrics.has(DB_METRIC_NAMES.backends)).toBe(false); // skipped this tick
    await provider.shutdown();
  });
});
