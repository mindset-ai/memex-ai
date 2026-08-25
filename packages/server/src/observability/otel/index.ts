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
  emissionAcceptedEvents = null;
  emissionAcceptedRequests = null;
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

// ── Emission ACCEPTED metric (spec-533 t-2, ac-19) ───────────────────────────
// The companion to the shed counters above, and deliberately the same shape: two
// instruments on the same meter, one for emissions and one for requests. spec-525
// ac-13 established why a single axis is not enough — "one 429 can destroy 500
// emissions while a per-request counter reads 1" — and the mirror image is what
// this Spec needs. Eight emissions in one batch and eight single POSTs carry the
// same event volume and describe opposite clients; only the second axis separates
// them, and their RATIO is the adoption signal:
//
//   ratio ≈ 1     one request per test   — the un-batched path
//   ratio ≈ 8–10  one request per file   — a client that batches
//
// WHY NOT READ IT BACK FROM `test_events`. Retention there is by COUNT, not age:
// RETENTION_KEEP = 10 per (subject_ref, test_identifier), trimmed inside the
// emission transaction (spec-398 dec-2). The busiest consumers therefore destroy
// their own history fastest, and no column records which route a row arrived on.
// The ratio is not merely at risk of being trimmed — it is not derivable from
// what the table stores. spec-525's dec-6 became unanswerable on exactly this,
// so dec-3 makes deciding where this number lands a prerequisite of shipping.
//
// READ CADENCE (dec-3 asks for this to be written down, not discovered later):
// the counters are cumulative and exported on the OTLP interval already wired by
// deploy.sh (MEMEX_OTEL_EXPORT_INTERVAL_MS). Read the ratio as a rate over a
// window wide enough to span a CI run — daily is the useful grain for adoption,
// since the thing being watched is repos changing a dependency range, not
// per-request behaviour. There is no retention to race: the metrics tier holds
// its own history independently of `test_events`.
let emissionAcceptedEvents: Counter | null = null;
let emissionAcceptedRequests: Counter | null = null;

/** The label set: bounded to two series by construction. See recordEmissionAccepted. */
export interface EmissionAcceptedLabels {
  /**
   * Which endpoint served it. This is the whole point of the metric: the route is
   * a fact about the request rather than a claim by the caller, and it is the only
   * thing on the wire that separates a client which batches from one which does
   * not — there is no User-Agent and no version field on either path.
   */
  readonly route: "single" | "batch";
}

/**
 * Record accepted emissions and the one request that carried them.
 *
 * `events` is the number of emissions ACCEPTED, so a partially-rejected batch
 * counts only what landed. That slightly understates a client's batching (ten
 * packed, two malformed, ratio reads 8) and is the honest reading of ac-19 as
 * written; rejected events are a small population and the distortion is toward
 * caution, never toward declaring adoption that did not happen.
 *
 * No-op unless OTLP telemetry is configured — the same contract as
 * {@link recordEmissionShed}, and for the same reason: telemetry-off is the normal
 * state in dev and CI, and an instrument that threw there would turn every
 * successful emission into a 500. Telemetry must never be able to break ingest.
 *
 * **Nothing tenant-shaped or credential-shaped is ever a label.** Not the key, not
 * a hash or prefix of it, not the memex id, namespace or Spec ref. spec-525 ac-14
 * bars the credential on cardinality grounds — the gate ahead of this route runs
 * before authentication, so presented tokens are caller-controlled and unbounded.
 * Here the reason is additionally that the question is about client BEHAVIOUR and
 * needs no identity to answer. Two series total.
 */
export function recordEmissionAccepted(
  events: number,
  labels: EmissionAcceptedLabels,
  config: OtelConfig = readOtelConfig(),
): void {
  if (events <= 0) return; // a fully-rejected request accepted nothing
  __emissionAcceptedProbe.record(events, labels);
  if (!config.enabled) return;
  if (!emissionAcceptedEvents || !emissionAcceptedRequests) {
    const meter = getDbTelemetry(config).provider.getMeter("memex.emission");
    emissionAcceptedEvents ??= meter.createCounter("memex.emission.accepted.events", {
      description:
        "AC emissions accepted at ingest (a batch counts its accepted length).",
    });
    emissionAcceptedRequests ??= meter.createCounter(
      "memex.emission.accepted.requests",
      {
        description:
          "Requests that carried accepted emissions — the companion axis; events/requests is the batching ratio.",
      },
    );
  }
  const attrs = { route: labels.route };
  emissionAcceptedEvents.add(events, attrs);
  emissionAcceptedRequests.add(1, attrs);
}

/**
 * Test-only in-memory mirror of {@link recordEmissionAccepted}, mirroring
 * unconditionally so the COUNTING CONTRACT is observable in the normal
 * telemetry-off state. Asserting it through a real OTLP exporter would test the
 * OpenTelemetry SDK rather than this Spec — the same reasoning as
 * {@link __emissionShedProbe}.
 */
export const __emissionAcceptedProbe = (() => {
  let events = 0;
  let requests = 0;
  const byRoute: Record<string, number> = {};
  return {
    record(n: number, labels: EmissionAcceptedLabels): void {
      events += n;
      requests += 1;
      byRoute[labels.route] = (byRoute[labels.route] ?? 0) + n;
    },
    reset(): void {
      events = 0;
      requests = 0;
      for (const k of Object.keys(byRoute)) delete byRoute[k];
    },
    snapshot(): { events: number; requests: number } {
      return { events, requests };
    },
    byRoute(): Record<string, number> {
      return { ...byRoute };
    },
    /** The label keys actually attached — asserted to never include a credential. */
    labelKeys(): string[] {
      return ["route"];
    },
  };
})();
