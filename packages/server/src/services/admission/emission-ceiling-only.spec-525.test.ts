// spec-525 t-13 / ac-14 + ac-21 — what the instance ceiling would refuse ON ITS OWN.
//
// THE QUESTION dec-6 CANNOT BE RESOLVED WITHOUT. The first full prod window showed 100%
// of would-be refusals caused by `key_slice_full` and 0% by `instance_ceiling_full`. That
// is not evidence the ceiling would never refuse — it is evidence the slice always refused
// FIRST, and structurally so: `#take` tests the slice before the ceiling, so a key already
// holding its slice can never reach the ceiling check. At prod's numbers (slice 1,
// ceiling 2) the ceiling branch is unreachable for the credential carrying ~90% of load.
//
// So the window measured a system in which one bound hid the other, and neither option A
// (raise the pool) nor option C (drop the slice) can be argued on data. This counter
// produces the missing number: how much would be refused if the slice did not exist.
//
// ────────────────────────────────────────────────────────────────────────────────────────
// IT IS AN UPPER BOUND, DELIBERATELY. STATE THIS WHEN QUOTING IT.
//
// The counterfactual counts a refusal when ceiling-only occupancy is full AT ARRIVAL. A
// real ceiling-only gate would also WAIT up to `waitMs` (250ms in prod) and would serve
// some of those arrivals from slots freed during the wait — 96% of observed refusals had
// `waited: true`, so that population is large.
//
// Modelling the wait faithfully would mean running a second queue with its own timers on
// the hot path. The bias is accepted instead, because it points the safe way: this number
// OVER-estimates what a ceiling-only gate would refuse. If it comes back small, option C
// is safe by a margin. If it comes back large, that is a signal to look harder rather than
// a verdict — the true figure is lower by an unmeasured amount.
// ────────────────────────────────────────────────────────────────────────────────────────

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { tagAc } from "@memex-ai-ac/vitest";
import { EmissionGate } from "./emission-gate.js";
import {
  startEmissionGateHeartbeat,
  _resetEmissionGateHeartbeat,
  GATE_WINDOW_EVENT,
} from "../../observability/emission-shed-log.js";

const SPEC = "mindset-prod/memex-building-itself/specs/spec-525/acs";
const AC_BOTH_AXES = `${SPEC}/ac-14`;
const AC_READABLE = `${SPEC}/ac-21`;

/** Let the simulation's microtasks drain — it is deliberately not awaited by `acquire`. */
const settle = () => new Promise((r) => setTimeout(r, 20));

/**
 * Acquire in shadow, where the caller is ALWAYS admitted, and narrow the union so the
 * release handle is reachable. Asserted rather than cast: if shadow ever started refusing,
 * that is the single most important regression this Spec could have, and a cast would hide
 * it behind a type error that never fires.
 */
async function admitted(gate: EmissionGate, key: string, weight: number) {
  const a = await gate.acquire(key, weight);
  if (!a.ok) throw new Error(`shadow mode refused — cause ${a.cause}`);
  return a;
}

describe("spec-525 ac-14: the ceiling-alone counterfactual answers what the slice was hiding", () => {
  it("ONE key filling the whole ceiling: the slice refuses, the ceiling would NOT have", async () => {
    tagAc(AC_BOTH_AXES);
    // THE test this task exists for. poolMax 4 → ceiling 2 → slice 1, prod's exact shape.
    const gate = new EmissionGate({ poolMax: 4, mode: "shadow", waitMs: 0 });
    expect(gate.ceiling).toBe(2);
    expect(gate.perKeySlice).toBe(1);

    // Two concurrent emissions from ONE credential — the mindset-four situation.
    const a = await admitted(gate, "loud", 1);
    const b = await admitted(gate, "loud", 1);
    await settle();

    // The slice refused the second: one key may hold 1.
    expect(gate.wouldShed.requestsByCause.key_slice_full).toBeGreaterThan(0);
    // …but 2 in flight is exactly the ceiling, so a ceiling-only gate would have served
    // BOTH. This divergence is the entire content of dec-6: the refusals prod is counting
    // are not protecting the pool, and until now nothing could show that.
    expect(gate.wouldShed.ceilingOnlyRequests).toBe(0);
    expect(gate.wouldShed.ceilingOnlyEvents).toBe(0);

    a.release();
    b.release();
  });

  it("past the ceiling, the counterfactual DOES count — it is not hardwired to zero", async () => {
    tagAc(AC_BOTH_AXES);
    const gate = new EmissionGate({ poolMax: 4, mode: "shadow", waitMs: 0 });

    // Three concurrent against a ceiling of 2: the third exceeds it on any gate.
    const held = [await admitted(gate, "k1", 1), await admitted(gate, "k2", 1)];
    await gate.acquire("k3", 5);
    await settle();

    // An anti-vacuity guard on the test above: a counter stuck at 0 would satisfy that
    // assertion for the wrong reason, and this is what separates the two.
    expect(gate.wouldShed.ceilingOnlyRequests).toBe(1);
    expect(gate.wouldShed.ceilingOnlyEvents).toBe(5);

    for (const h of held) h.release();
  });

  it("counts EMISSIONS and REQUESTS separately, like every other axis (t-12)", async () => {
    tagAc(AC_BOTH_AXES);
    const gate = new EmissionGate({ poolMax: 4, mode: "shadow", waitMs: 0 });
    const held = [await admitted(gate, "k1", 1), await admitted(gate, "k2", 1)];

    await gate.acquire("k3", 100);
    await gate.acquire("k4", 100);
    await settle();

    // A single number here would repeat exactly the defect t-12 fixed, on a counter whose
    // whole purpose is to be quoted in a decision.
    expect(gate.wouldShed.ceilingOnlyRequests).toBe(2);
    expect(gate.wouldShed.ceilingOnlyEvents).toBe(200);

    for (const h of held) h.release();
  });

  it("releases its occupancy — a finished request must not hold the counterfactual open", async () => {
    tagAc(AC_BOTH_AXES);
    const gate = new EmissionGate({ poolMax: 4, mode: "shadow", waitMs: 0 });

    const a = await admitted(gate, "k1", 1);
    const b = await admitted(gate, "k2", 1);
    a.release();
    b.release();
    await settle();

    // With both slots given back, a third arrival must be admitted by the counterfactual.
    // A leak here would make the counter drift toward "refuses everything" over hours and
    // silently argue for option A.
    await gate.acquire("k3", 1);
    await settle();
    expect(gate.wouldShed.ceilingOnlyRequests).toBe(0);
  });
});

describe("spec-525 ac-21: the counterfactual reaches the window record", () => {
  let lines: string[] = [];
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    lines = [];
    logSpy = vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => {
      lines.push(a.map(String).join(" "));
    });
  });

  afterEach(() => {
    _resetEmissionGateHeartbeat();
    logSpy.mockRestore();
  });

  it("the heartbeat publishes both counterfactual axes", async () => {
    tagAc(AC_READABLE);
    const gate = new EmissionGate({ poolMax: 4, mode: "shadow", waitMs: 0 });
    const held = [await admitted(gate, "k1", 1), await admitted(gate, "k2", 1)];
    await gate.acquire("k3", 9);
    await settle();

    startEmissionGateHeartbeat({ gate: () => gate, intervalMs: 20 });
    await new Promise((r) => setTimeout(r, 50));

    const w = lines
      .map((l) => JSON.parse(l) as Record<string, unknown>)
      .find((r) => r.event === GATE_WINDOW_EVENT);

    // A counter nobody can read from outside the process is the defect t-11 fixed; a
    // counter that exists only in a unit test repeats it in miniature.
    expect(w?.ceilingOnlyWouldShedEvents).toBe(9);
    expect(w?.ceilingOnlyWouldShedRequests).toBe(1);

    for (const h of held) h.release();
  });
});
