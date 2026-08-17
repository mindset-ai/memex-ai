// spec-525 t-12 / ac-14 + ac-21 — the shadow counter counts BOTH axes, and says which is which.
//
// THE DEFECT THIS PINS, found in production data rather than in review. `WouldShedCount`'s
// doc comment read "how many EMISSIONS enforcing would have refused"; the code did
// `this.#wouldShedTotal += 1` — one per REQUEST, whatever the batch weighed. t-11's
// heartbeat then published that number as `wouldShed`, and ac-21's text called it "the
// wouldShed delta" without naming a unit. Every surface said or implied emissions; every
// one of them carried requests.
//
// ac-13 states the rule the shadow path was breaking: "The counter's unit is EMISSIONS
// LOST, not requests refused … one 429 can destroy 500 emissions while a per-request
// counter reads 1." The OTEL counter already honours it (`#reportShed(weight, …)`); the
// shadow counter did not — and the shadow counter is the one t-10 reads.
//
// MEASURED ON THE LIVE WINDOW, which is why this is not a style complaint. Prod revision
// memex-api-00132-64q, per-shed records over 2.7 h: 3 000 refused requests carrying
// 24 323 emissions — a mean of ~8.1 emissions per refused request, batches up to 261. A
// reader taking the heartbeat's number as events under-reports by ~8×, and the error grows
// with batch size, which spec-489's batching work exists to increase.
//
// So both axes are now first-class and named for their unit. ac-14 already required this
// ("refusals must ALSO be countable as requests — either a second instrument or a second
// dimension"); this brings the shadow path up to a criterion already on the board.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { tagAc } from "@memex-ai-ac/vitest";
import { EmissionGate } from "./emission-gate.js";
import {
  startEmissionGateHeartbeat,
  _resetEmissionGateHeartbeat,
  GATE_WINDOW_EVENT,
} from "../../observability/emission-shed-log.js";

const SPEC = "mindset-prod/memex-building-itself/specs/spec-525/acs";
const AC_BOTH_AXES = `${SPEC}/ac-14`; // says WHY, and requests are countable separately
const AC_READABLE = `${SPEC}/ac-21`; // the record a human can read afterwards

/**
 * Fill the gate, then shed one batch of `weight`.
 *
 * The shed MUST go through `acquire`, not `tryAcquire`: the latter is the raw primitive
 * and says so in its own header — "It does not know about shadow mode. Counting-without-
 * refusing is t-3, layered on." A `tryAcquire` shed increments nothing, so a test built on
 * it reads zero and looks like a missing feature. And the simulation is deliberately not
 * awaited (awaiting it would add the wait interval to real requests), so its microtasks
 * need draining before the counter is read.
 */
async function shedOneBatch(weight: number): Promise<EmissionGate> {
  const gate = new EmissionGate({ poolMax: 2, mode: "shadow", waitMs: 0 });
  for (let i = 0; i < gate.ceiling + 2; i++) gate.tryAcquire("occupant", 1);
  await gate.acquire("loud", weight);
  await new Promise((r) => setTimeout(r, 20));
  return gate;
}

describe("spec-525 ac-14: the shadow counter separates EMISSIONS from REQUESTS", () => {
  it("a shed batch of 500 counts 500 emissions and 1 request — never 1 and 1", async () => {
    tagAc(AC_BOTH_AXES);
    const gate = await shedOneBatch(500);

    // THE assertion. Before this, `total` was 1 for both, under a comment promising
    // emissions — so one refused CI file read as a single lost verification result.
    expect(gate.wouldShed.events).toBe(500);
    expect(gate.wouldShed.requests).toBe(1);
  });

  it("splits BOTH axes by cause, so neither can be inferred from the other", async () => {
    tagAc(AC_BOTH_AXES);
    const gate = await shedOneBatch(7);

    // 'one shed batch of 500' vs '500 shed single POSTs' is the distinction ac-14 exists
    // for, and it is invisible unless the cause split carries both units.
    //
    // Asserted on the SUM across causes rather than on a named one: this fixture saturates
    // the instance ceiling with the occupant, so the refusal is `instance_ceiling_full`,
    // not `key_slice_full`. Hardcoding the cause tested the fixture rather than the split —
    // and it is the same confusion prod showed, where 100% of refusals were the OTHER cause.
    const e = gate.wouldShed.eventsByCause;
    const r = gate.wouldShed.requestsByCause;
    expect(e.key_slice_full + e.instance_ceiling_full).toBe(7);
    expect(r.key_slice_full + r.instance_ceiling_full).toBe(1);
    // Each split must reconcile with its own axis total, or one of them is bookkeeping
    // that nobody maintains.
    expect(e.key_slice_full + e.instance_ceiling_full).toBe(gate.wouldShed.events);
    expect(r.key_slice_full + r.instance_ceiling_full).toBe(gate.wouldShed.requests);
  });

  it("the two axes agree only when every shed is a single-event POST", async () => {
    tagAc(AC_BOTH_AXES);
    const singles = new EmissionGate({ poolMax: 2, mode: "shadow", waitMs: 0 });
    for (let i = 0; i < singles.ceiling + 2; i++) singles.tryAcquire("occupant", 1);
    for (let i = 0; i < 5; i++) await singles.acquire("loud", 1);
    await new Promise((r) => setTimeout(r, 20));

    // A guard against a "fix" that simply aliases one field to the other: with weight 1
    // they MUST coincide, which is exactly why the old bug survived review.
    expect(singles.wouldShed.events).toBe(singles.wouldShed.requests);
    expect(singles.wouldShed.events).toBeGreaterThan(0);
  });
});

describe("spec-525 ac-21: the heartbeat publishes both axes under names that state the unit", () => {
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

  it("reports wouldShedEvents AND wouldShedRequests, not one ambiguous number", async () => {
    tagAc(AC_READABLE);
    const gate = await shedOneBatch(500);
    startEmissionGateHeartbeat({ gate: () => gate, intervalMs: 20 });
    await new Promise((r) => setTimeout(r, 50));

    const w = lines
      .map((l) => JSON.parse(l) as Record<string, unknown>)
      .find((r) => r.event === GATE_WINDOW_EVENT);

    expect(w).toBeDefined();
    // Named for the unit. `wouldShed` alone is what let a request count be read as an
    // emission count for twelve hours of production window.
    expect(w?.wouldShedEvents).toBe(500);
    expect(w?.wouldShedRequests).toBe(1);
    // And the ambiguous name must be GONE, not merely joined by clearer siblings — a
    // reader who finds it will use it.
    expect("wouldShed" in (w ?? {})).toBe(false);
    expect("wouldShedTotal" in (w ?? {})).toBe(false);
  });
});
