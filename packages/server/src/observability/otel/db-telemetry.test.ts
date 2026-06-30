import { describe, it, expect } from "vitest";
import { tagAc } from "@memex-ai-ac/vitest";
import {
  AggregationTemporality,
  type DataPoint,
  InMemoryMetricExporter,
  type MetricReader,
  MeterProvider,
  PeriodicExportingMetricReader,
} from "@opentelemetry/sdk-metrics";
import type { Meter } from "@opentelemetry/api";
import {
  DB_METRIC_NAMES,
  DB_OPERATION_ATTR,
  createDbInstruments,
  instrumentSqlClient,
  normaliseOp,
} from "./db-telemetry.js";

const AC1 = "mindset-prod/memex-building-itself/specs/spec-412/acs/ac-1";
const AC5 = "mindset-prod/memex-building-itself/specs/spec-412/acs/ac-5";

// ── isolated in-memory meter for assertions ──────────────────────────────────
function testMeter(): { meter: Meter; reader: MetricReader; provider: MeterProvider } {
  const exporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
  const reader = new PeriodicExportingMetricReader({
    exporter,
    exportIntervalMillis: 2_147_483_647, // never auto-fires; we collect() manually
  });
  const provider = new MeterProvider({ readers: [reader] });
  return { meter: provider.getMeter("test"), reader, provider };
}

async function collect(
  reader: MetricReader,
): Promise<Map<string, DataPoint<unknown>[]>> {
  const { resourceMetrics } = await reader.collect();
  const out = new Map<string, DataPoint<unknown>[]>();
  for (const sm of resourceMetrics.scopeMetrics) {
    for (const m of sm.metrics) {
      out.set(m.descriptor.name, m.dataPoints as DataPoint<unknown>[]);
    }
  }
  return out;
}

// ── a fake postgres-js client mirroring the unsafe()/.values() surface ───────
interface FakeOpts {
  rows?: Array<Record<string, unknown>>;
  fail?: boolean;
}
function fakeClient(opts: FakeOpts = {}) {
  const rows = opts.rows ?? [{ a: 1 }];
  let unsafeCalls = 0;
  const settle = <T>(v: T): Promise<T> =>
    opts.fail ? Promise.reject(new Error("boom")) : Promise.resolve(v);
  const make = (asValues: boolean) => ({
    then: (f?: (v: unknown) => unknown, r?: (e: unknown) => unknown) =>
      settle(asValues ? rows.map((r) => Object.values(r)) : rows).then(f, r),
    catch: (r?: (e: unknown) => unknown) =>
      settle(asValues ? rows.map((r) => Object.values(r)) : rows).catch(r),
    finally: (f?: () => void) =>
      settle(asValues ? rows.map((r) => Object.values(r)) : rows).finally(f),
    values: () => make(true),
  });
  return {
    unsafe: (_q: string, _p?: unknown[]) => {
      unsafeCalls += 1;
      return make(false);
    },
    get calls() {
      return unsafeCalls;
    },
  };
}

describe("normaliseOp — statement → bounded verb, no PII (ac-5)", () => {
  it("extracts and uppercases the leading verb", () => {
    tagAc(AC5);
    expect(normaliseOp("select 1")).toBe("SELECT");
    expect(normaliseOp("INSERT INTO t VALUES (1)")).toBe("INSERT");
    expect(normaliseOp("  update t set x=1")).toBe("UPDATE");
    expect(normaliseOp("DELETE FROM t")).toBe("DELETE");
    expect(normaliseOp("with cte as (select 1) select * from cte")).toBe("WITH");
  });

  it("skips leading comments", () => {
    tagAc(AC5);
    expect(normaliseOp("-- a comment\nselect 1")).toBe("SELECT");
    expect(normaliseOp("/* block */ SELECT 1")).toBe("SELECT");
  });

  it("collapses anything outside the known set to OTHER (cardinality guard)", () => {
    tagAc(AC5);
    expect(normaliseOp("pg_sleep(10)")).toBe("OTHER");
    expect(normaliseOp("")).toBe("OTHER");
    // @ts-expect-error — defensive: non-string input must not throw
    expect(normaliseOp(null)).toBe("OTHER");
  });

  it("never leaks a literal value into the label", () => {
    tagAc(AC5);
    const op = normaliseOp("SELECT * FROM users WHERE email = 'secret@x.com'");
    expect(op).toBe("SELECT");
    expect(op).not.toContain("secret");
    expect(op).not.toContain("@");
  });
});

describe("instrumentSqlClient — query metrics, out-of-band (ac-1, ac-5)", () => {
  it("records latency + throughput on the await path, preserving rows", async () => {
    tagAc(AC1);
    const { meter, reader, provider } = testMeter();
    const instruments = createDbInstruments(meter);
    const base = fakeClient({ rows: [{ id: 7 }] });
    const client = instrumentSqlClient(base, instruments);

    const rows = await client.unsafe("SELECT id FROM t");
    expect(rows).toEqual([{ id: 7 }]); // result untouched

    const metrics = await collect(reader);
    expect(metrics.has(DB_METRIC_NAMES.queryDuration)).toBe(true);
    expect(metrics.has(DB_METRIC_NAMES.queryCount)).toBe(true);
    const count = metrics.get(DB_METRIC_NAMES.queryCount)?.[0];
    expect(count?.value).toBe(1);
    await provider.shutdown();
  });

  it("records on the .values() path too (Drizzle's SELECT field mapper)", async () => {
    tagAc(AC1);
    const { meter, reader, provider } = testMeter();
    const instruments = createDbInstruments(meter);
    const client = instrumentSqlClient(fakeClient({ rows: [{ id: 7 }] }), instruments);

    const arrays = await client.unsafe("SELECT id FROM t").values();
    expect(arrays).toEqual([[7]]);

    const metrics = await collect(reader);
    expect(metrics.get(DB_METRIC_NAMES.queryCount)?.[0]?.value).toBe(1);
    await provider.shutdown();
  });

  it("counts errors and re-throws (error/timeout rate)", async () => {
    tagAc(AC1);
    const { meter, reader, provider } = testMeter();
    const instruments = createDbInstruments(meter);
    const client = instrumentSqlClient(fakeClient({ fail: true }), instruments);

    await expect(client.unsafe("SELECT 1")).rejects.toThrow("boom");

    const metrics = await collect(reader);
    expect(metrics.get(DB_METRIC_NAMES.queryErrors)?.[0]?.value).toBe(1);
    await provider.shutdown();
  });

  it("labels carry ONLY the normalised operation — never the literal (ac-5)", async () => {
    tagAc(AC5);
    const { meter, reader, provider } = testMeter();
    const instruments = createDbInstruments(meter);
    const client = instrumentSqlClient(fakeClient(), instruments);

    await client.unsafe("SELECT * FROM users WHERE token = 'mxt_supersecret'");

    const metrics = await collect(reader);
    for (const [, points] of metrics) {
      for (const dp of points) {
        const keys = Object.keys(dp.attributes);
        expect(keys).toEqual([DB_OPERATION_ATTR]);
        expect(dp.attributes[DB_OPERATION_ATTR]).toBe("SELECT");
        // No attribute value may carry the secret literal or an identity key.
        const blob = JSON.stringify(dp.attributes);
        expect(blob).not.toContain("supersecret");
        expect(blob.toLowerCase()).not.toContain("memexid");
        expect(blob.toLowerCase()).not.toContain("userid");
      }
    }
    await provider.shutdown();
  });

  it("is out-of-band: recording + collecting issues NO extra DB calls (ac-1)", async () => {
    tagAc(AC1);
    const { meter, reader, provider } = testMeter();
    const instruments = createDbInstruments(meter);
    const base = fakeClient();
    const client = instrumentSqlClient(base, instruments);

    await client.unsafe("SELECT 1");
    await client.unsafe("SELECT 2");
    await collect(reader); // export/collect must not touch the DB

    expect(base.calls).toBe(2); // exactly the app queries — telemetry adds none
    await provider.shutdown();
  });

  it("tracks in-flight queries and returns to zero once settled", async () => {
    tagAc(AC1);
    const { meter, provider } = testMeter();
    const instruments = createDbInstruments(meter);
    expect(instruments.getInFlight()).toBe(0);

    // A query the test controls the resolution of.
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const base = {
      unsafe: (_query: string, _params?: unknown[]) => ({
        then: (f?: (v: unknown) => unknown, r?: (e: unknown) => unknown) =>
          gate.then(() => [{ ok: 1 }]).then(f, r),
        values: () => ({ then: () => gate.then(() => [[1]]) }),
      }),
    };
    const client = instrumentSqlClient(base, instruments);

    const inflight = client.unsafe("SELECT 1");
    const awaited = Promise.resolve(inflight); // begin consumption
    await Promise.resolve(); // let the microtask register enter()
    expect(instruments.getInFlight()).toBe(1);

    release();
    await awaited;
    expect(instruments.getInFlight()).toBe(0);
    await provider.shutdown();
  });
});
