// spec-525 t-14 / ac-28 — the DENOMINATOR. Total arrivals, on both axes.
//
// WHY THIS EXISTS. t-13's shadow window measured 35 547 would-be refused requests carrying
// 135 801 emissions over 7 days. That is an absolute count with NOTHING to divide it by,
// and ac-2 asks for a RATE. What fraction of traffic that represents decides whether
// enforcing is viable at all: 0.5% and a ceiling of 3 may be fine; 30% and no tuning here
// is close.
//
// AND IT IS UNRECOVERABLE RETROACTIVELY, verified rather than assumed (dec-6, t-14):
//   - the gate held no total counter, and the heartbeat published 16 fields, none a total
//   - Cloud Run's `request_count` metric carries no URL-path label
//   - request logs are sampled
//   - `test_events` is trimmed INSIDE the emission transaction to 10 rows per
//     (subject_ref, test_identifier) pair, so a row count measures what SURVIVED, not what
//     arrived — and the ingest route states there is no second trace: "test_event is NOT
//     persisted to activity_log (it's the firehose)"
//
// So it can only be counted going forward, which is what this is.
//
// BOTH AXES, not the single integer t-14 asked for. The shed counters are already split
// events/requests because neither can be inferred from the other — t-12 measured ~8.1
// emissions per refused request, batches to 261 — and a rate needs its denominator on the
// SAME axis as its numerator. One arrivals integer would leave the EVENTS-axis rate
// uncomputable, and that is the axis ac-13 states the counter's unit is.
//
// COUNTED AT ARRIVAL, before any bound is evaluated and regardless of mode. In shadow every
// caller is admitted, so counting admissions would make the denominator the numerator's
// complement and the rate meaningless.

import { describe, it, expect, afterEach, vi } from "vitest";
import { tagAc } from "@memex-ai-ac/vitest";
import { EmissionGate } from "./emission-gate.js";
import {
  startEmissionGateHeartbeat,
  _resetEmissionGateHeartbeat,
  GATE_WINDOW_EVENT,
} from "../../observability/emission-shed-log.js";

const SPEC = "mindset-prod/memex-building-itself/specs/spec-525/acs";
const AC_ARRIVALS = `${SPEC}/ac-28`;

describe("spec-525 ac-28: total arrivals, on both axes", () => {
  it("counts every arrival on both axes, admitted or refused", async () => {
    tagAc(AC_ARRIVALS);

    // poolMax 4 -> ceiling 2, per-key allowance 1. Enforcing, so some of these really are
    // refused — which is the point: an arrival is an arrival either way.
    const gate = new EmissionGate({ poolMax: 4, mode: "enforcing", waitMs: 0 });
    expect(gate.arrivals.requests).toBe(0);
    expect(gate.arrivals.events).toBe(0);

    const held = [gate.tryAcquire("a", 10), gate.tryAcquire("b", 20)]; // admitted: 2 req / 30 ev
    const refused = [gate.tryAcquire("c", 5), gate.tryAcquire("d", 7)]; // refused:  2 req / 12 ev
    expect(held.every((h) => h.ok)).toBe(true);
    expect(refused.every((r) => !r.ok)).toBe(true);

    // 4 arrivals carrying 42 emissions — regardless of what the bounds decided.
    expect(gate.arrivals.requests).toBe(4);
    expect(gate.arrivals.events).toBe(10 + 20 + 5 + 7);

    held.forEach((h) => h.ok && h.release());
  });

  it("counts arrivals in SHADOW, where nothing is refused", async () => {
    tagAc(AC_ARRIVALS);

    // THE CASE THAT MATTERS, because shadow is the mode the measurement runs in. Every
    // caller is admitted here, so a counter that incremented on admission would produce a
    // denominator that cannot disagree with the numerator — and a rate of exactly zero
    // forever, which reads as good news.
    const gate = new EmissionGate({ poolMax: 4, mode: "shadow", waitMs: 5 });
    const results = await Promise.all([
      gate.acquire("a", 3),
      gate.acquire("b", 3),
      gate.acquire("loud", 500),
      gate.acquire("loud", 500),
      gate.acquire("loud", 500),
    ]);
    await new Promise((r) => setTimeout(r, 40));

    expect(results.every((r) => r.ok)).toBe(true); // shadow refuses nothing
    expect(gate.arrivals.requests).toBe(5);
    expect(gate.arrivals.events).toBe(3 + 3 + 500 + 500 + 500);

    // And the simulation DID count would-be sheds against those arrivals, so a rate is
    // now computable on each axis from one instrument.
    expect(gate.wouldShed.requests).toBeGreaterThan(0);
    expect(gate.wouldShed.requests).toBeLessThanOrEqual(gate.arrivals.requests);
    expect(gate.wouldShed.events).toBeLessThanOrEqual(gate.arrivals.events);

    results.forEach((r) => r.ok && r.release());
  });

  it("the two axes are not each other — which is why there are two", async () => {
    tagAc(AC_ARRIVALS);

    // A single arrivals integer would have made the events-axis rate uncomputable. On the
    // live window t-12 measured ~8.1 emissions per refused request (batches to 261), so
    // the axes diverge by an order of magnitude in practice.
    const gate = new EmissionGate({ poolMax: 4, mode: "shadow", waitMs: 0 });
    await gate.acquire("a", 500);
    expect(gate.arrivals.requests).toBe(1);
    expect(gate.arrivals.events).toBe(500);
    expect(gate.arrivals.events).not.toBe(gate.arrivals.requests);
  });

  it("a release does not decrement an arrival — it is a flow, not an occupancy", async () => {
    tagAc(AC_ARRIVALS);

    // The distinction from `inFlight` / `inFlightEvents`, which DO go down. Arrivals are
    // cumulative-forever per instance, because a rate divides a window's sheds by that
    // window's arrivals; a counter that fell back would make the ratio unreadable.
    const gate = new EmissionGate({ poolMax: 4, mode: "enforcing", waitMs: 0 });
    const a = gate.tryAcquire("a", 9);
    expect(gate.arrivals.requests).toBe(1);
    if (a.ok) a.release();
    expect(gate.arrivals.requests).toBe(1);
    expect(gate.arrivals.events).toBe(9);
    expect(gate.inFlight).toBe(0); // occupancy went back, arrivals did not
  });

  it("a rate is computable from one instrument, and it is bounded by construction", async () => {
    tagAc(AC_ARRIVALS);

    // What ac-2 actually needs. Not asserted against a magic number — asserted as the
    // PROPERTY that makes the number meaningful: the ratio exists, and it lies in [0, 1]
    // on each axis, which is exactly what an absolute count could never promise.
    const gate = new EmissionGate({ poolMax: 4, mode: "shadow", waitMs: 5 });
    await Promise.all(
      Array.from({ length: 12 }, (_, i) => gate.acquire(i % 3 === 0 ? "loud" : `k${i}`, 8)),
    );
    await new Promise((r) => setTimeout(r, 60));

    for (const axis of ["requests", "events"] as const) {
      const rate = gate.wouldShed[axis] / gate.arrivals[axis];
      expect(Number.isFinite(rate)).toBe(true);
      expect(rate).toBeGreaterThanOrEqual(0);
      expect(rate).toBeLessThanOrEqual(1);
    }
    expect(gate.arrivals.requests).toBe(12);
    expect(gate.arrivals.events).toBe(96);
  });
});

describe("spec-525 ac-28: the denominator reaches the heartbeat, or t-10 cannot read it", () => {
  afterEach(() => {
    _resetEmissionGateHeartbeat();
    vi.restoreAllMocks();
  });

  it("publishes both axes as a WINDOW DELTA and a cumulative total", async () => {
    tagAc(AC_ARRIVALS);

    // The half that matters operationally. An in-process getter is invisible from outside:
    // t-11 established that `EmissionGate.wouldShed` is exposed by no route and dies with
    // the instance, which is why the shadow window "counted into a void". A denominator
    // that only exists in memory repeats that exactly.
    const gate = new EmissionGate({ poolMax: 4, mode: "shadow", waitMs: 0 });
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((l: unknown) => {
      if (typeof l === "string" && l.includes(GATE_WINDOW_EVENT)) lines.push(l);
    });

    startEmissionGateHeartbeat({ gate: () => gate, intervalMs: 10 });
    await new Promise((r) => setTimeout(r, 30)); // a first, quiet window

    const held = await Promise.all([gate.acquire("a", 7), gate.acquire("b", 11)]);
    await new Promise((r) => setTimeout(r, 40)); // a window WITH arrivals in it

    expect(lines.length).toBeGreaterThanOrEqual(2);
    const last = JSON.parse(lines[lines.length - 1]);

    // The four fields, mirroring the shed axes exactly.
    for (const k of [
      "arrivalEvents",
      "arrivalRequests",
      "arrivalEventsTotal",
      "arrivalRequestsTotal",
    ]) {
      expect(last, `heartbeat must publish ${k}`).toHaveProperty(k);
      expect(Number.isFinite(last[k])).toBe(true);
    }

    // Cumulative caught everything presented; the delta is bounded by it. Asserted as a
    // relationship rather than an exact delta, because which 10 ms window a call lands in
    // is a timing race and pinning it would make this flaky rather than strict.
    expect(last.arrivalRequestsTotal).toBe(2);
    expect(last.arrivalEventsTotal).toBe(18);
    expect(last.arrivalRequests).toBeLessThanOrEqual(last.arrivalRequestsTotal);
    expect(last.arrivalEvents).toBeLessThanOrEqual(last.arrivalEventsTotal);

    // AND THE POINT OF ALL OF IT: a rate is now readable from one line of one instrument.
    expect(last.wouldShedRequestsTotal / last.arrivalRequestsTotal).toBeLessThanOrEqual(1);

    held.forEach((h) => h.ok && h.release());
  });
});
