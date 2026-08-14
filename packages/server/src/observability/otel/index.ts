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
  emissionShedEvents = null;
  emissionShedRequests = null;
}

// ── Emission admission shed metric (spec-525 t-5, ac-13 / ac-14) ─────────────
// Same shape as the RLS counter above and for the same reason: a correctness /
// load signal, not a DB-health one, so it rides the shared MeterProvider on its
// own meter rather than db-telemetry's instruments.
//
// TWO instruments, not one, and that is ac-14's requirement rather than taste.
// `/api/test-events/batch` carries up to MAX_BATCH_EVENTS = 500 events and the
// emitter drops the WHOLE bucket on a 429 with no fallback (emit.ts). So one shed
// batch of 500 and 500 shed single POSTs are identical on the event axis and
// completely different situations — the first is one CI file, the second is a
// client hammering the un-batched path. Only a second axis separates them.
let emissionShedEvents: Counter | null = null;
let emissionShedRequests: Counter | null = null;

/** The label set. Bounded and low-cardinality BY CONSTRUCTION — see recordEmissionShed. */
export interface EmissionShedLabels {
  /** Which bound refused: the credential's own slice, or the instance ceiling. */
  readonly cause: "key_slice_full" | "instance_ceiling_full";
  /**
   * Whether the request waited before being refused. Not decoration: a refusal AFTER
   * waiting means the instance was busy for the whole interval (accidental overload,
   * where holding the slot is correct); a refusal WITHOUT waiting means the waiter set
   * was already full (a flood, where refusing instantly preserves capacity). Opposite
   * operator responses, so it is a dimension rather than a footnote.
   */
  readonly waited: boolean;
}

/**
 * Record one shed (or, in shadow mode, one would-be shed).
 *
 * `events` is the number of EMISSIONS lost, not requests refused — 1 for the
 * single-event route, the batch's length for `/batch`. No-op unless OTLP telemetry is
 * configured, exactly like {@link recordRlsContextViolation}: telemetry-off is the
 * normal local state, and an instrument that threw there would turn every shed into a
 * 500 — a load-protection mechanism becoming an outage.
 *
 * **The credential is never a label**, hashed or otherwise. The gate runs ahead of
 * authentication on a public route, so the set of presented tokens is caller-controlled
 * and unbounded; labelling it would be a metrics-cardinality problem an attacker can
 * drive at will. Only `cause` (2 values) and `waited` (2) are carried — four series.
 */
export function recordEmissionShed(
  events: number,
  labels: EmissionShedLabels,
  config: OtelConfig = readOtelConfig(),
): void {
  __emissionShedProbe.record(events, labels);
  if (!config.enabled) return;
  if (!emissionShedEvents || !emissionShedRequests) {
    const meter = getDbTelemetry(config).provider.getMeter("memex.emission");
    emissionShedEvents ??= meter.createCounter("memex.emission.shed.events", {
      description:
        "AC emissions lost to admission shedding (a shed batch counts its full length).",
    });
    emissionShedRequests ??= meter.createCounter("memex.emission.shed.requests", {
      description:
        "Requests refused by admission shedding — the companion axis to shed.events.",
    });
  }
  const attrs = { cause: labels.cause, waited: String(labels.waited) };
  emissionShedEvents.add(events, attrs);
  emissionShedRequests.add(1, attrs);
}

/**
 * Test-only in-memory mirror of what {@link recordEmissionShed} recorded.
 *
 * It exists because the property under test is the COUNTING CONTRACT — that a batch of
 * 500 adds 500 rather than 1, that requests are a separate axis, that no credential
 * reaches a label — and asserting that through a real OTLP exporter would test the
 * OpenTelemetry SDK instead of this Spec. It mirrors unconditionally so the contract is
 * observable in the normal telemetry-off state of dev and CI.
 */
export const __emissionShedProbe = (() => {
  let events = 0;
  let requests = 0;
  const byCause: Record<string, number> = {};
  const byWaited: Record<string, number> = {};
  return {
    record(n: number, labels: EmissionShedLabels): void {
      events += n;
      requests += 1;
      byCause[labels.cause] = (byCause[labels.cause] ?? 0) + n;
      const w = String(labels.waited);
      byWaited[w] = (byWaited[w] ?? 0) + 1;
    },
    reset(): void {
      events = 0;
      requests = 0;
      for (const k of Object.keys(byCause)) delete byCause[k];
      for (const k of Object.keys(byWaited)) delete byWaited[k];
    },
    get events() {
      return events;
    },
    get requests() {
      return requests;
    },
    snapshot(): { events: number; requests: number } {
      return { events, requests };
    },
    byLabel(which: "cause" | "waited"): Record<string, number> {
      return which === "cause" ? { ...byCause } : { ...byWaited };
    },
    /** The label keys actually attached — asserted to never include a credential. */
    labelKeys(): string[] {
      return ["cause", "waited"];
    },
  };
})();
