// spec-525 t-16 / ac-25 + ac-22 + ac-23 — dec-6's second term: the gate bounds EVENTS in
// flight, not only requests.
//
// WHY A SECOND TERM AT ALL. The gate's bound counted requests. c-18 measured what the
// queue actually costs and it is not requests: a queued request retains its parsed body
// at 1.1-1.5x its wire bytes, so 80 concurrent worst-case batches (500 events x 4 KB of
// metadata) would retain ~181 MB against prod's ~149 MB of headroom, while the observed
// shape (~8 events per batch) retains ~2.9 MB. Exactly one shape is dangerous and it is
// the simultaneous maximum of every dimension — invisible to a request count, which reads
// two 500-event batches (1 000 events) as less load than three single-event POSTs.
//
// THE CORRECTION THIS ENCODES. c-18 claimed "the gate already carries `weight` through
// `acquire()`, so the quantity is in hand; only the bound is expressed in the wrong unit."
// True for the COUNTERS, false for the BOUND: `#take` never received `weight` — it tested
// `perKeySlice` and `ceiling` against `#inFlight`, both request-counted, and `weight`
// reached only `#reportShed` and the shadow totals. dec-6 records the correction; these
// tests are it.
//
// WHAT DOES NOT MOVE (ac-23). `deriveCeiling` stays `floor(poolMax * 0.5)`. dec-6's
// finding is asymmetric: the request cap was never wrong AS a request cap — it is what
// keeps user traffic's access to the slots of the very pool it derives from, the third
// resource c-19 separated out and the one nobody has costed. The events budget is added
// ALONGSIDE it. A reading that replaced it would trade a measured-rare risk for an
// unmeasured one.
//
// The new check is appended LAST in `#take`, deliberately: the existing cause split stays
// bit-for-bit comparable with the shadow window t-13 already read (99.0% key_slice_full,
// 1.0% instance_ceiling_full). A new bound inserted ahead of them would have re-labelled
// history.

import { describe, it, expect } from "vitest";
import { tagAc } from "@memex-ai-ac/vitest";
import {
  EmissionGate,
  deriveCeiling,
  resolveEventBudget,
  DEFAULT_EVENT_BUDGET,
} from "./emission-gate.js";

const SPEC = "mindset-prod/memex-building-itself/specs/spec-525/acs";
const AC_EVENT_BUDGET = `${SPEC}/ac-22`;
const AC_REQUEST_TERM = `${SPEC}/ac-23`;
const AC_WEIGHT_REACHES_BOUND = `${SPEC}/ac-25`;

describe("spec-525 ac-25: weight reaches the bound, and comes back exactly once", () => {
  it("moves the in-flight events total by exactly the weight, in both directions", () => {
    tagAc(AC_WEIGHT_REACHES_BOUND);

    const gate = new EmissionGate({ poolMax: 4, mode: "enforcing", waitMs: 0 });
    expect(gate.inFlightEvents).toBe(0);

    const a = gate.tryAcquire("a", 37);
    expect(a.ok).toBe(true);
    // Not "greater than zero" — EXACTLY the weight. An off-by-anything here is a bound
    // measuring a quantity nobody declared.
    expect(gate.inFlightEvents).toBe(37);

    if (a.ok) a.release();
    expect(gate.inFlightEvents).toBe(0);
  });

  it("a doubled release leaves the events total unchanged", () => {
    tagAc(AC_WEIGHT_REACHES_BOUND);

    // THE property that matters under pressure. A middleware with an error path can
    // plausibly release twice; a gate that decremented twice would drift OPEN under
    // exactly the load it exists to bound — and on the event axis the drift is weighted,
    // so one doubled release on a 500-event batch opens 500 events of room that is not
    // there. The request axis already had this guard; the events axis must share it.
    const gate = new EmissionGate({ poolMax: 4, mode: "enforcing", waitMs: 0 });
    const a = gate.tryAcquire("a", 250);
    expect(gate.inFlightEvents).toBe(250);

    if (a.ok) {
      a.release();
      a.release();
      a.release();
    }
    expect(gate.inFlightEvents).toBe(0);
    // And the request axis stayed honest through the same double-release.
    expect(gate.inFlight).toBe(0);
  });

  it("accumulates weights across credentials rather than counting requests", () => {
    tagAc(AC_WEIGHT_REACHES_BOUND);

    const gate = new EmissionGate({ poolMax: 8, mode: "enforcing", waitMs: 0, eventBudget: 10_000 });
    const held = [gate.tryAcquire("a", 8), gate.tryAcquire("b", 500)];
    expect(held.every((h) => h.ok)).toBe(true);

    // 2 requests, 508 events. The whole point: these two numbers are not each other.
    expect(gate.inFlight).toBe(2);
    expect(gate.inFlightEvents).toBe(508);

    held.forEach((h) => h.ok && h.release());
  });
});

describe("spec-525 ac-22: the events budget refuses on its own axis", () => {
  it("refuses a batch that would exceed the budget while the request ceiling has room", () => {
    tagAc(AC_EVENT_BUDGET);

    // poolMax 8 -> ceiling 4, so the request cap is nowhere near full at 2 requests.
    // The refusal can therefore only come from the events term.
    const gate = new EmissionGate({ poolMax: 8, mode: "enforcing", waitMs: 0, eventBudget: 1_000 });
    const first = gate.tryAcquire("a", 600);
    expect(first.ok).toBe(true);

    const refused = gate.tryAcquire("b", 600); // 1 200 > 1 000
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.cause).toBe("event_budget_full");
      // Distinct from both existing causes — an operator seeing this must not go and
      // resize the pool or blame a loud credential.
      expect(refused.cause).not.toBe("key_slice_full");
      expect(refused.cause).not.toBe("instance_ceiling_full");
    }
    // The request ceiling really did have room: this is the events term, not the old one.
    expect(gate.inFlight).toBeLessThan(gate.ceiling);

    if (first.ok) first.release();
  });

  it("admits the same event total split across many small requests only while it fits", () => {
    tagAc(AC_EVENT_BUDGET);

    // One 500-event batch and 500 single-event POSTs are the same load on this axis —
    // the distinction the request ceiling could not make. Here: a budget of 20 admits
    // ten 2-event requests and refuses the eleventh, at a ceiling of 16 requests.
    const gate = new EmissionGate({ poolMax: 32, mode: "enforcing", waitMs: 0, eventBudget: 20 });
    const held = [];
    for (let i = 0; i < 10; i++) held.push(gate.tryAcquire(`k${i}`, 2));
    expect(held.every((h) => h.ok)).toBe(true);
    expect(gate.inFlightEvents).toBe(20);

    const refused = gate.tryAcquire("k10", 2);
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.cause).toBe("event_budget_full");

    // Freeing one 2-event request makes exactly room for one more.
    const one = held.pop();
    if (one?.ok) one.release();
    const admitted = gate.tryAcquire("k11", 2);
    expect(admitted.ok).toBe(true);
    if (admitted.ok) admitted.release();

    held.forEach((h) => h.ok && h.release());
  });

  it("defaults to a budget that cannot refuse anything at today's ceiling", () => {
    tagAc(AC_EVENT_BUDGET);

    // SAFE RATHER THAN TUNED, the same discipline DEFAULT_GATE_MODE follows: dec-6 leaves
    // the values to t-10's shadow A/B, so the compiled-in default must not be able to
    // refuse before anyone has measured. At prod's ceiling of 2, the most events that can
    // ever be in flight is 2 x MAX_BATCH_EVENTS = 1 000, so a default well above that is
    // provably inert — it becomes load-bearing only when the ceiling rises.
    const MAX_REACHABLE_AT_PROD = deriveCeiling(4) * 500;
    expect(MAX_REACHABLE_AT_PROD).toBe(1_000);
    expect(DEFAULT_EVENT_BUDGET).toBeGreaterThan(MAX_REACHABLE_AT_PROD);

    // And it is configurable without a code change, like every other knob (ac-18): t-10
    // turns it from the canonical secret, not from a literal in this file.
    expect(resolveEventBudget({})).toBe(DEFAULT_EVENT_BUDGET);
    expect(resolveEventBudget({ MEMEX_EMISSION_EVENT_BUDGET: "4096" })).toBe(4096);
    // Junk must not yield NaN — a bound whose every comparison is false is not a bound.
    expect(resolveEventBudget({ MEMEX_EMISSION_EVENT_BUDGET: "banana" })).toBe(DEFAULT_EVENT_BUDGET);
    expect(resolveEventBudget({ MEMEX_EMISSION_EVENT_BUDGET: "0" })).toBe(DEFAULT_EVENT_BUDGET);
    expect(resolveEventBudget({ MEMEX_EMISSION_EVENT_BUDGET: "-5" })).toBe(DEFAULT_EVENT_BUDGET);
  });
});

describe("spec-525 ac-23: the request term survives dec-6 unchanged", () => {
  it("still derives the ceiling as half the resolved pool, floored", () => {
    tagAc(AC_REQUEST_TERM);

    // Pinned at prod's shape and at the neighbours, so a later edit to the share is a
    // visible change rather than a silent one. dec-6 rejected option D (0.75) precisely
    // to keep this invariant, so it is worth a test that would catch it moving.
    expect(deriveCeiling(4)).toBe(2); // prod
    expect(deriveCeiling(5)).toBe(2); // the code default — floors, does not round
    expect(deriveCeiling(8)).toBe(4);
    expect(deriveCeiling(1)).toBe(1); // never zero: a pool of one still admits one
  });

  it("still refuses with instance_ceiling_full when the request cap is what filled", () => {
    tagAc(AC_REQUEST_TERM);

    // The events budget is generous here, so the only bound that can bite is the old one.
    // If a future change made the events term primary, this goes red — which is the point:
    // the two terms are additive, not alternatives.
    const gate = new EmissionGate({
      poolMax: 4,
      mode: "enforcing",
      waitMs: 0,
      eventBudget: 1_000_000,
    });
    const held = [gate.tryAcquire("a", 1), gate.tryAcquire("b", 1)];
    expect(held.every((h) => h.ok)).toBe(true);
    expect(gate.inFlight).toBe(gate.ceiling);

    const refused = gate.tryAcquire("c", 1);
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.cause).toBe("instance_ceiling_full");

    held.forEach((h) => h.ok && h.release());
  });
});
