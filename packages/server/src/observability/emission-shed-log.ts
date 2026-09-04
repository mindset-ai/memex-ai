// spec-525 t-11 / ac-21 — the shed record that survives the process.
//
// WHY THIS EXISTS ALONGSIDE ac-13's COUNTER, rather than instead of it. `recordEmissionShed`
// returns at `if (!config.enabled) return;` unless `OTEL_EXPORTER_OTLP_ENDPOINT` is set,
// and on 2026-08-16 it was set in NEITHER environment — checked against the running prod
// revision `memex-api-00131-zk5`, whose 40 env vars do not include it. The only other
// record, `EmissionGate.wouldShed`, is an in-process getter no route exposes, held in the
// memory of instances that recycle. So the shadow window opened on 2026-08-14 13:10:19 UTC
// and counted into a void, leaving t-10 — "read the counter by cause, set the wait interval
// and waiter bound from that data" — with no input at all.
//
// THIS IS NOT ac-13, AND CLOSING ac-21 MUST NOT CLOSE IT. ac-13 states that "a log line
// alone fails this" and is right: the 2026-08-11 incident had `writesFailed: 251` sitting
// in the logs and was still found by a person saying the app was broken. ac-13 wants an
// ALERTABLE metric and stays unsatisfied until an OTLP endpoint exists. This wants a
// READABLE measurement — the one-time read that lets ac-2's ceiling and wait interval come
// from shadow data instead of being chosen in advance. Different needs; this serves one.
//
// WHY ENTIRELY-JSON, DEPARTING FROM THE REPO'S `console.log("[domain] …")` STYLE. Cloud Run
// ships stdout to Cloud Logging, which lifts a line into a queryable `jsonPayload` only when
// the WHOLE line parses as JSON — a `[emission-gate] ` prefix leaves it an opaque
// textPayload. Aggregating by cause is the entire point, so the prefix loses more than the
// consistency gains. `severity` is likewise a field Cloud Logging reads out of the payload.
//
// NOT std-14's domain logger. That one fans out to `packages/server/.logs/<domain>.log`,
// which is a local-dev debugging aid: on Cloud Run the filesystem is ephemeral, and a file
// write per shed would put I/O on the exact path this Spec exists to keep cheap.
//
// VOLUME, stated so a reviewer can check it rather than discover it. One line per shed,
// bounded by request rate — peak measured 2 063 POST/min. Worst case ≈3M lines/day at
// ~200 bytes ≈ 600 MB/day, under $1/day of Cloud Logging ingest, for a window of days.
// Re-judge if the window is extended or if enforcing mode runs indefinitely.

import type {
  ArrivalCount,
  GateMode,
  ShedCause,
  WouldShedCount,
} from "../services/admission/emission-gate.js";
import { SHED_CAUSES, zeroByCause } from "../services/admission/emission-gate.js";

/**
 * Per-cause delta over the whole vocabulary (ac-26).
 *
 * Kept here rather than exported from the gate: the heartbeat is its only consumer, and a
 * symbol with one consumer belongs in that consumer [per std-51].
 */
function deltaByCause(
  now: Record<ShedCause, number>,
  before: Record<ShedCause, number>,
): Record<ShedCause, number> {
  const out = zeroByCause();
  for (const cause of SHED_CAUSES) out[cause] = now[cause] - before[cause];
  return out;
}

/** One refused (or, in shadow, would-be refused) request. */
export interface ShedRecord {
  /** EMISSIONS lost — the batch's length, not 1. Same unit as ac-13's counter. */
  readonly events: number;
  /** Which bound refused: the credential's own slice, or the instance ceiling. */
  readonly cause: ShedCause;
  /** Refused AFTER waiting (accidental overload) or WITHOUT (a flood). Opposite responses. */
  readonly waited: boolean;
  /** `shadow` means nothing was actually refused — the record is a counterfactual. */
  readonly mode: GateMode;
}

/** The marker every record carries, so the window can be filtered by name not by shape. */
export const SHED_LOG_EVENT = "emission_shed";

/**
 * Write one shed to stdout as a single line of JSON.
 *
 * **The credential is never written**, in any form. The gate runs BEFORE authentication on
 * a public route, so the presented token is an unverified, caller-controlled secret. ac-14
 * bars it from metric labels for cardinality reasons; the reason here is stronger — logs
 * are retained and broadly readable, so a credential written once is a credential leaked.
 *
 * Deliberately not wrapped in try/catch: `JSON.stringify` over four primitives cannot
 * throw, and `console.log` failing would mean stdout itself is gone. Swallowing here would
 * only hide a defect, and unlike the emitter's POST there is no network to fail.
 */
export function logEmissionShed(record: ShedRecord): void {
  console.log(
    JSON.stringify({
      event: SHED_LOG_EVENT,
      // A real refusal loses verification results; a shadow one loses nothing and is the
      // expected state during the window. Same event, different operator meaning.
      severity: record.mode === "enforcing" ? "WARNING" : "INFO",
      cause: record.cause,
      waited: record.waited,
      events: record.events,
      // The companion axis to `events`: one shed batch of 500 and 500 shed single POSTs
      // are identical on the event count and completely different situations.
      requests: 1,
      mode: record.mode,
    }),
  );
}

/** The shape the heartbeat reads. Structural, so the gate needs no knowledge of this file. */
export interface GateSnapshotSource {
  readonly mode: GateMode;
  readonly ceiling: number;
  readonly perKeySlice: number;
  readonly inFlight: number;
  /**
   * dec-6's second axis. Published because t-10 cannot set the events budget without it:
   * a knob whose governed quantity is not observable is a number someone guesses, which
   * is the defect dec-3 exists to prevent. Not derivable from `inFlight` — two requests
   * can be 2 events or 1 000.
   */
  readonly inFlightEvents: number;
  /** The budget those events are measured against, so a window is readable on its own. */
  readonly eventBudget: number;
  readonly trackedKeys: number;
  readonly wouldShed: WouldShedCount;
  /**
   * TOTAL ARRIVALS — the denominator t-13's window did not have (spec-525 t-14, ac-28).
   * Published on BOTH axes because a rate needs its denominator on the same axis as its
   * numerator, and `wouldShed` is already split for that reason.
   */
  readonly arrivals: ArrivalCount;
}

export const GATE_WINDOW_EVENT = "emission_gate_window";

/** Same cadence as `[BUS METRICS]`, so the two read side by side in one log stream. */
const GATE_WINDOW_INTERVAL_MS = 60_000;

let heartbeat: ReturnType<typeof setInterval> | null = null;

/**
 * Start the periodic window record. Returns the timer so startup can `.unref()` it,
 * matching `startBusObservability` (`index.ts:36`).
 *
 * **It NEVER skips a quiet window**, which is the one place it deliberately diverges from
 * `[BUS METRICS]`. That logger skips a window with no activity — correct there, fatal
 * here: a window with nothing shed is precisely the observation this exists to record.
 * Records present with zero counters mean the instrument works and nothing was refused;
 * no records at all mean the instrument is broken. Without that, four days of silence in
 * Cloud Logging cannot be told apart from the defect this task was opened to fix.
 *
 * **Deltas as well as a cumulative total.** `wouldShed` is per-instance and dies when the
 * instance recycles, which on Cloud Run is routine. Summing per-window deltas across every
 * heartbeat and every instance survives that; the cumulative alone loses whatever a dead
 * instance had counted.
 *
 * The gate is passed as an accessor rather than imported: the gate lives in the middleware,
 * which imports this file, so importing it back would be a cycle. It is also called lazily
 * inside the tick, which preserves the gate's deliberate build-on-first-use behaviour — and
 * means the first heartbeat proves the log path works even on an instance that has served
 * no emission traffic at all.
 */
export function startEmissionGateHeartbeat(opts: {
  gate: () => GateSnapshotSource;
  intervalMs?: number;
}): ReturnType<typeof setInterval> | null {
  if (heartbeat) return heartbeat;
  const intervalMs = opts.intervalMs ?? GATE_WINDOW_INTERVAL_MS;
  // Only the DELTA'd axes. The ceiling-alone counterfactual (t-13) is reported cumulative
  // on purpose — it is read once, at dec-6, not tracked window by window — so it has no
  // place in the previous-window state and typing it as the full WouldShedCount would be
  // a lie the compiler happens to accept.
  type DeltaState = Pick<
    WouldShedCount,
    "events" | "requests" | "eventsByCause" | "requestsByCause"
  > & {
    // Arrivals are delta'd with the sheds, never reported only as a cumulative: a RATE
    // divides a window's refusals by THAT window's arrivals. Two cumulative totals from
    // different instances, or across a recycle, do not divide (spec-525 t-14, ac-28).
    arrivalEvents: number;
    arrivalRequests: number;
  };
  let previous: DeltaState | null = null;

  heartbeat = setInterval(() => {
    try {
      const g = opts.gate();
      const now = g.wouldShed;
      const before =
        previous ?? {
          events: 0,
          requests: 0,
          eventsByCause: zeroByCause(),
          requestsByCause: zeroByCause(),
          arrivalEvents: 0,
          arrivalRequests: 0,
        };
      previous = {
        events: now.events,
        requests: now.requests,
        eventsByCause: { ...now.eventsByCause },
        requestsByCause: { ...now.requestsByCause },
        arrivalEvents: g.arrivals.events,
        arrivalRequests: g.arrivals.requests,
      };

      console.log(
        JSON.stringify({
          event: GATE_WINDOW_EVENT,
          severity: "INFO",
          mode: g.mode,
          windowMs: intervalMs,
          // The bounds are DERIVED from the pool at runtime, so they are not knowable from
          // the source a week later. A count without them cannot be reasoned about.
          ceiling: g.ceiling,
          perKeySlice: g.perKeySlice,
          inFlight: g.inFlight,
          // dec-6's second term: the occupancy and the budget it is measured against.
          // t-10 sets the budget from these two, the same way it sets the ceiling from
          // `inFlight` — a bound whose governed quantity is unpublished can only be
          // guessed at.
          inFlightEvents: g.inFlightEvents,
          eventBudget: g.eventBudget,
          trackedKeys: g.trackedKeys,
          // BOTH axes, each named for its unit (t-12). A single `wouldShed` field is what
          // let a request count be read as an emission count for twelve hours of window:
          // measured at ~8.1 emissions per refused request, batches up to 261.
          wouldShedEvents: now.events - before.events,
          wouldShedRequests: now.requests - before.requests,
          // Built by ITERATING the vocabulary, never by naming its members (ac-26). The
          // hand-written form this replaces named both causes, so a third one would have
          // been dropped from the published window outright — no error, no gap, no clue,
          // in the one instrument t-10 reads to set the bounds.
          wouldShedEventsByCause: deltaByCause(now.eventsByCause, before.eventsByCause),
          wouldShedRequestsByCause: deltaByCause(now.requestsByCause, before.requestsByCause),
          wouldShedEventsTotal: now.events,
          wouldShedRequestsTotal: now.requests,
          // THE DENOMINATOR (spec-525 t-14, ac-28). t-13's window had 35 547 refused
          // requests carrying 135 801 emissions and nothing to divide them by, and the
          // quantity is unrecoverable retroactively — so it is counted going forward.
          // Per-window deltas so `wouldShedRequests / arrivalRequests` is a rate within
          // ONE window, plus cumulative totals because the counter is per-instance and
          // dies on recycle (32 distinct instances in 12 h of prod).
          arrivalEvents: g.arrivals.events - before.arrivalEvents,
          arrivalRequests: g.arrivals.requests - before.arrivalRequests,
          arrivalEventsTotal: g.arrivals.events,
          arrivalRequestsTotal: g.arrivals.requests,
          // t-13 — the ceiling-alone counterfactual, an UPPER BOUND (see WouldShedCount).
          // Cumulative rather than a delta: this one is read once, at dec-6, not tracked
          // window by window, and a running total is what a single query wants.
          ceilingOnlyWouldShedEvents: now.ceilingOnlyEvents,
          ceilingOnlyWouldShedRequests: now.ceilingOnlyRequests,
        }),
      );
    } catch (err) {
      // A periodic observer that throws is a worse failure than the gap it reports — the
      // rule `[BUS METRICS]` states for its own snapshot. Catching INSIDE the tick (rather
      // than around the interval) is what lets it recover: a heartbeat that died on its
      // first bad tick would be silence again, which is the defect, not the fix.
      console.error("[emission-gate] heartbeat failed (passive — ignoring):", err);
    }
  }, intervalMs);

  return heartbeat;
}

/** Test-only: stop the timer and clear state so a suite can re-arm with a tighter interval. */
export function _resetEmissionGateHeartbeat(): void {
  if (heartbeat) clearInterval(heartbeat);
  heartbeat = null;
}
