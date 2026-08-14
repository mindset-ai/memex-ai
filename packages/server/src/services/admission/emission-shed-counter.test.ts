// spec-525 t-5 — the shed counter: counted in EMISSIONS, labelled by cause.
//
// The instrument that makes shedding knowable. Without it a shed emission leaves an
// acceptance criterion holding an older status, and nothing distinguishes "not
// re-verified" from "verification discarded".
//
// A log line does not satisfy ac-13, and the reason is on the record: the 2026-08-11
// incident had `writesFailed: 251` in the logs and was still found by a person saying
// the app was broken.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { tagAc } from "@memex-ai-ac/vitest";
import {
  recordEmissionShed,
  __emissionShedProbe,
} from "../../observability/otel/index.js";
import { EmissionGate } from "./emission-gate.js";

const SPEC = "mindset-prod/memex-building-itself/specs/spec-525/acs";
const AC_COUNTER = `${SPEC}/ac-13`; // a named counter on the shared meter, in EMISSIONS
const AC_LABELS = `${SPEC}/ac-14`; // says WHY, and requests are countable separately

beforeEach(() => {
  __emissionShedProbe.reset();
});

afterEach(() => {
  __emissionShedProbe.reset();
  vi.unstubAllEnvs();
});

describe("spec-525 ac-13: the unit is emissions lost, not requests refused", () => {
  it("a shed batch of N events increments the counter by N, not by 1", () => {
    tagAc(AC_COUNTER);
    // /api/test-events/batch carries up to MAX_BATCH_EVENTS = 500, and the emitter
    // drops the WHOLE bucket on a 429 with no fallback. A per-request counter would
    // read 1 while 500 verification results were destroyed — and that gap widens as
    // Half B moves more clients onto batching.
    recordEmissionShed(500, { cause: "instance_ceiling_full", waited: true });
    expect(__emissionShedProbe.events).toBe(500);
    expect(__emissionShedProbe.requests).toBe(1);
  });

  it("a shed single POST counts one emission and one request", () => {
    tagAc(AC_COUNTER);
    recordEmissionShed(1, { cause: "key_slice_full", waited: false });
    expect(__emissionShedProbe.events).toBe(1);
    expect(__emissionShedProbe.requests).toBe(1);
  });

  it("is a no-op when no OTLP endpoint is configured — it must never throw in dev or tests", () => {
    tagAc(AC_COUNTER);
    // The template's contract (recordRlsContextViolation, spec-440 dec-2): telemetry
    // off is the normal local state, and an instrument that threw there would make
    // every shed a 500 — turning a load-protection mechanism into an outage.
    expect(() =>
      recordEmissionShed(
        3,
        { cause: "key_slice_full", waited: false },
        { enabled: false, exportIntervalMs: 60_000, poolMax: 5 },
      ),
    ).not.toThrow();
  });
});

describe("spec-525 ac-14: the counter says WHY, and requests are countable separately", () => {
  it("distinguishes one shed batch of 500 from 500 shed single POSTs", () => {
    tagAc(AC_LABELS);
    // Same event total, completely different situations: the first is one CI file,
    // the second is a client hammering the un-batched path. A single instrument
    // cannot tell them apart, which is why ac-14 requires both.
    recordEmissionShed(500, { cause: "instance_ceiling_full", waited: true });
    const batch = { ...__emissionShedProbe.snapshot() };

    __emissionShedProbe.reset();
    for (let i = 0; i < 500; i++) {
      recordEmissionShed(1, { cause: "instance_ceiling_full", waited: true });
    }
    const singles = __emissionShedProbe.snapshot();

    expect(batch.events).toBe(singles.events); // identical on the event axis…
    expect(batch.requests).toBe(1);
    expect(singles.requests).toBe(500); // …and unmistakable on the request axis
  });

  it("carries the cause, and the two causes are distinguishable in the series", () => {
    tagAc(AC_LABELS);
    recordEmissionShed(2, { cause: "key_slice_full", waited: false });
    recordEmissionShed(3, { cause: "instance_ceiling_full", waited: false });
    const byCause = __emissionShedProbe.byLabel("cause");
    expect(byCause.key_slice_full).toBe(2);
    expect(byCause.instance_ceiling_full).toBe(3);
  });

  it("carries `waited`, which separates accidental overload from a flood", () => {
    tagAc(AC_LABELS);
    // A refusal AFTER waiting means the instance was busy for the whole interval —
    // accidental overload, where holding the slot is right. A refusal WITHOUT waiting
    // means the waiter set was already full — a flood, where refusing instantly is
    // what preserves capacity. Opposite operator responses, so it is a dimension.
    recordEmissionShed(1, { cause: "instance_ceiling_full", waited: true });
    recordEmissionShed(1, { cause: "instance_ceiling_full", waited: false });
    const byWaited = __emissionShedProbe.byLabel("waited");
    expect(byWaited.true).toBe(1);
    expect(byWaited.false).toBe(1);
  });

  it("NEVER labels the credential — not the token, not a hash of it, not a tenant id", () => {
    tagAc(AC_LABELS);
    // The gate runs before authentication on a public route, so the set of presented
    // credentials is caller-controlled and unbounded. A credential label would be a
    // metrics-cardinality problem that an attacker can drive at will.
    recordEmissionShed(1, { cause: "key_slice_full", waited: false });
    const labels = __emissionShedProbe.labelKeys();
    expect(labels.sort()).toEqual(["cause", "waited"]);
  });
});

describe("spec-525 ac-13/ac-17: the gate reports sheds, in shadow as well as enforcing", () => {
  it("an ENFORCING shed reports its weight and cause through the hook", () => {
    tagAc(AC_COUNTER);
    const seen: Array<{ weight: number; cause: string; waited: boolean }> = [];
    const gate = new EmissionGate({
      poolMax: 2, // ceiling 1
      mode: "enforcing",
      waitMs: 0,
      onShed: (weight, cause, waited) => seen.push({ weight, cause, waited }),
    });
    // Fill it, then shed a batch of 500.
    for (let i = 0; i < gate.ceiling + 1; i++) gate.tryAcquire("occupant", 1);
    gate.tryAcquire("someone-else", 500);

    expect(seen.length).toBeGreaterThanOrEqual(1);
    const last = seen[seen.length - 1];
    expect(last.weight).toBe(500);
    expect(last.cause).toBe("instance_ceiling_full");
  });

  it("a SHADOW would-be shed reports through the same hook — this is what makes ac-17's count reach ac-13's counter", async () => {
    tagAc(AC_COUNTER);
    // ac-17 says would-be sheds are counted "on ac-13's counter". Until this hook
    // existed the shadow count lived only in an in-module field, so ac-17 was green
    // on a weaker property than it states. This is the wire.
    const seen: number[] = [];
    const gate = new EmissionGate({
      poolMax: 2,
      mode: "shadow",
      waitMs: 0,
      onShed: (weight) => seen.push(weight),
    });
    for (let i = 0; i < gate.ceiling + 2; i++) gate.tryAcquire("occupant", 1);
    const admitted = await gate.acquire("loud", 500);

    // Shadow admits regardless…
    expect(admitted.ok).toBe(true);
    // …and the simulation is not awaited, so let its microtasks drain.
    await new Promise((r) => setTimeout(r, 20));
    expect(gate.wouldShed.total).toBeGreaterThan(0);
    expect(seen).toContain(500);
  });
});
