// spec-525 t-11 / ac-21 — the heartbeat that makes SILENCE interpretable.
//
// WHY THE PER-SHED LINE IS NOT ENOUGH, learned by trying it rather than by reasoning.
// On 2026-08-16 the per-shed record shipped to int and then refused to produce a single
// line under 200, and then 1 500, concurrent requests. The cause was not the log: an
// unauthenticated request never awaits anything (`test-events.ts:227` —
// `rawKey ? await verifyEmissionKey(rawKey) : null`), so it traverses the gate and
// releases its slot inside one tick of the event loop. Simulated occupancy never exceeds
// 1, and int's per-key slice IS 1 (pool 5 → ceiling 2 → slice `ceiling - 1`). No
// contention is reachable that way, at any burst size.
//
// That left the original defect only half fixed. A per-shed line makes a shed readable,
// but it cannot make ZERO readable — and after four days of window, "Cloud Logging
// returns nothing" would still mean either "nothing was ever refused" (the good news) or
// "the log is broken" (the bug we just fixed), with no way to tell them apart. Shipping a
// measurement whose silence is ambiguous is the same class of mistake as the instrument
// wired to a backend that does not exist.
//
// So the heartbeat reports the window's state on a timer, unconditionally.
//
//   records present, counters zero  → the log works AND nothing was refused
//   no records at all               → the log is broken
//
// THE DELIBERATE DIVERGENCE FROM `[BUS METRICS]`. That logger, whose timer shape this one
// copies, applies a skip-zero rule: "a quiet window (no writes, no emits) doesn't warrant
// a log line". Correct there, fatal here — a quiet window is exactly the observation this
// exists to record. Do not "align" the two.
//
// WHY DELTAS AS WELL AS A CUMULATIVE TOTAL. `wouldShed` is per-instance and dies when the
// instance recycles, which on Cloud Run is routine. Summing the per-window deltas across
// every heartbeat and every instance survives that; reading the cumulative alone would
// lose whatever an instance had counted before it went away.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { tagAc } from "@memex-ai-ac/vitest";
import {
  zeroByCause,
  DEFAULT_EVENT_BUDGET,
} from "../services/admission/emission-gate.js";
import {
  startEmissionGateHeartbeat,
  _resetEmissionGateHeartbeat,
  GATE_WINDOW_EVENT,
  type GateSnapshotSource,
} from "./emission-shed-log.js";

const AC_READABLE = "mindset-prod/memex-building-itself/specs/spec-525/acs/ac-21";

let lines: string[] = [];
let logSpy: ReturnType<typeof vi.spyOn>;

const windows = () =>
  lines
    .map((l) => JSON.parse(l) as Record<string, unknown>)
    .filter((r) => r.event === GATE_WINDOW_EVENT);

/** A stand-in for the gate, so the heartbeat can be driven without building a real one. */
function fakeGate(over: Partial<GateSnapshotSource> = {}): GateSnapshotSource {
  return {
    mode: "shadow",
    ceiling: 2,
    perKeySlice: 1,
    inFlight: 0,
    // dec-6's second axis. Published so t-10 can set the budget from data rather than
    // from a guess (ac-22).
    inFlightEvents: 0,
    eventBudget: DEFAULT_EVENT_BUDGET,
    // The denominator (ac-28). A shed COUNT without it is what left t-13's window
    // unusable for ac-2, so the heartbeat carries both axes.
    arrivals: { events: 0, requests: 0 },
    trackedKeys: 0,
    wouldShed: {
      events: 0,
      requests: 0,
      // Built from the vocabulary, not from a literal pair (ac-26): a literal is what
      // goes stale when a cause is added — and here the compiler DOES catch it, which is
      // the difference between this site and the sum assertions it cannot see.
      eventsByCause: zeroByCause(),
      requestsByCause: zeroByCause(),
      ceilingOnlyEvents: 0,
      ceilingOnlyRequests: 0,
    },
    ...over,
  };
}

beforeEach(() => {
  lines = [];
  logSpy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  });
});

afterEach(() => {
  // [per std-37] cl-5: restore what the test replaced, and stop the timer — a leaked
  // interval would keep logging into a sibling test's captured console.
  _resetEmissionGateHeartbeat();
  logSpy.mockRestore();
  vi.useRealTimers();
});

describe("spec-525 ac-21: the heartbeat makes a QUIET window observable", () => {
  it("emits a record when nothing has been shed — the whole point", async () => {
    tagAc(AC_READABLE);
    startEmissionGateHeartbeat({ gate: () => fakeGate(), intervalMs: 20 });
    await new Promise((r) => setTimeout(r, 70));

    // THE assertion this file exists for. Without it, "Cloud Logging returns nothing"
    // after four days is unreadable: no way to separate a healthy quiet window from a
    // broken instrument. `[BUS METRICS]`'s skip-zero rule would fail this test.
    expect(windows().length).toBeGreaterThanOrEqual(1);
    expect(windows()[0].wouldShedEvents).toBe(0);
    expect(windows()[0].wouldShedRequests).toBe(0);
  });

  it("carries the gate's configuration, so the window's numbers can be interpreted later", async () => {
    tagAc(AC_READABLE);
    startEmissionGateHeartbeat({
      gate: () => fakeGate({ ceiling: 2, perKeySlice: 1, mode: "shadow" }),
      intervalMs: 20,
    });
    await new Promise((r) => setTimeout(r, 50));

    const w = windows()[0];
    // t-10 sets the ceiling and wait interval FROM this data. A count with no record of
    // the bounds that produced it cannot be reasoned about a week later — and the bounds
    // are derived from the pool at runtime, so they are not knowable from the source.
    expect(w.ceiling).toBe(2);
    expect(w.perKeySlice).toBe(1);
    expect(w.mode).toBe("shadow");
  });

  it("is valid JSON with a stable marker, exactly like the per-shed record", async () => {
    tagAc(AC_READABLE);
    startEmissionGateHeartbeat({ gate: () => fakeGate(), intervalMs: 20 });
    await new Promise((r) => setTimeout(r, 50));

    expect(lines.length).toBeGreaterThanOrEqual(1);
    expect(() => JSON.parse(lines[0])).not.toThrow();
    expect(JSON.parse(lines[0]).event).toBe(GATE_WINDOW_EVENT);
  });
});

describe("spec-525 ac-21: the heartbeat reports per-window deltas that survive instance recycling", () => {
  it("reports what changed in the window, then reports zero once it stops changing", async () => {
    tagAc(AC_READABLE);
    let events = 0;
    let requests = 0;
    startEmissionGateHeartbeat({
      gate: () =>
        fakeGate({
          wouldShed: {
            events,
            requests,
            eventsByCause: { ...zeroByCause(), key_slice_full: events },
            requestsByCause: { ...zeroByCause(), key_slice_full: requests },
            ceilingOnlyEvents: 0,
            ceilingOnlyRequests: 0,
          },
        }),
      intervalMs: 25,
    });

    // 7 EMISSIONS lost across 1 refused REQUEST — the ratio the old single field hid.
    events = 7;
    requests = 1;
    await new Promise((r) => setTimeout(r, 40)); // first window sees the 7
    await new Promise((r) => setTimeout(r, 40)); // second sees no further change

    const w = windows();
    expect(w.length).toBeGreaterThanOrEqual(2);
    expect(w[0].wouldShedEvents).toBe(7);
    expect(w[0].wouldShedRequests).toBe(1);
    expect((w[0].wouldShedEventsByCause as Record<string, number>).key_slice_full).toBe(7);
    expect((w[0].wouldShedRequestsByCause as Record<string, number>).key_slice_full).toBe(1);
    // Summing deltas across every heartbeat and every instance is what survives a Cloud
    // Run recycle; reading the cumulative alone loses whatever a dead instance held.
    expect(w[1].wouldShedEvents).toBe(0);
    expect(w[1].wouldShedRequests).toBe(0);
    // …while the cumulative stays available for a single-instance sanity check.
    expect(w[1].wouldShedEventsTotal).toBe(7);
    expect(w[1].wouldShedRequestsTotal).toBe(1);
  });
});

describe("spec-525 ac-21: the heartbeat can never take the server down", () => {
  it("survives a gate accessor that throws, and keeps ticking afterwards", async () => {
    tagAc(AC_READABLE);
    let boom = true;
    startEmissionGateHeartbeat({
      gate: () => {
        if (boom) throw new Error("gate unavailable");
        return fakeGate();
      },
      intervalMs: 20,
    });

    await new Promise((r) => setTimeout(r, 45));
    boom = false;
    await new Promise((r) => setTimeout(r, 45));

    // A periodic observer that throws is a worse failure than the gap it reports — the
    // same rule `[BUS METRICS]` states for its own snapshot. And it must RECOVER, not
    // merely avoid crashing: a heartbeat that dies on its first bad tick is silence again.
    expect(windows().length).toBeGreaterThanOrEqual(1);
  });

  it("is idempotent — a second start does not double the records", async () => {
    tagAc(AC_READABLE);
    startEmissionGateHeartbeat({ gate: () => fakeGate(), intervalMs: 20 });
    startEmissionGateHeartbeat({ gate: () => fakeGate(), intervalMs: 20 });
    await new Promise((r) => setTimeout(r, 50));

    const perTick = windows().length;
    // ANTI-VACUITY FIRST: an upper bound alone passes when NOTHING is logged, which is
    // exactly the state this whole file exists to make impossible. It passed against the
    // red stub for that reason. Assert the records exist before asserting there aren't
    // too many.
    expect(perTick).toBeGreaterThanOrEqual(1);
    // Two timers would double every count read off this log, silently — and the reader
    // has no way to detect it. Guarded here rather than trusted, matching the `started`
    // flag `[BUS METRICS]` uses.
    expect(perTick).toBeLessThanOrEqual(3);
  });

  it("returns the timer so startup can unref it — an unref'd timer cannot hold the process open", async () => {
    tagAc(AC_READABLE);
    const timer = startEmissionGateHeartbeat({ gate: () => fakeGate(), intervalMs: 20 });
    // index.ts does `start…()?.unref()`, matching startBusObservability. A null return
    // would make that a silent no-op and the heartbeat would never run in production.
    expect(timer).not.toBeNull();
    expect(typeof timer?.unref).toBe("function");
  });
});
