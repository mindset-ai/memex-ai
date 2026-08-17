// spec-525 t-3 — shadow mode: evaluate the bounds, count what WOULD have been refused,
// refuse nothing.
//
// This is the mode the first deploy runs, and it is what produces the number ac-2 now
// demands. dec-3's principle — "a threshold chosen before the mechanism has run in
// production is a guess" — applied to this Spec's own parameters: the ceiling and the
// wait interval are set from a week of real traffic, not from the arithmetic in dec-4.
//
// WHAT "SHADOW" HAD TO MEAN, because three readings were available and they measure
// different things:
//   (a) count contention at arrival only — cheap, but an upper bound, and it never sees
//       the wait, so it measures a different mechanism than the one being enforced;
//   (b) actually wait, then admit anyway — measures the truth, but adds the full interval
//       to real requests, which breaks "a mode that refuses nothing cannot make anything
//       worse";
//   (c) run the WHOLE gate — bounds, queue, timeouts — against its own counters while the
//       caller passes through untouched.
// (c) is what is built: the only reading that satisfies "the wait path runs in shadow too"
// at zero cost to the caller. The would-shed count is therefore the genuine counterfactual
// — what enforcing would have refused, timeouts included — not a proxy for it.

import { describe, it, expect } from "vitest";
import { tagAc } from "@memex-ai-ac/vitest";
import { EmissionGate, resolveGateMode, DEFAULT_GATE_MODE } from "./emission-gate.js";

const SPEC = "mindset-prod/memex-building-itself/specs/spec-525/acs";
const AC_SHADOW = `${SPEC}/ac-17`; // refuses nothing, counts what it would have refused
const AC_LABELS = `${SPEC}/ac-14`; // the count says WHY, in the same vocabulary as enforcing

const settle = () => new Promise((r) => setTimeout(r, 0));

describe("spec-525 ac-17: shadow refuses nothing", () => {
  it("admits everything under load far past both bounds, and still counts", async () => {
    tagAc(AC_SHADOW);
    const gate = new EmissionGate({ poolMax: 4, mode: "shadow", waitMs: 20 });

    const results = await Promise.all(
      Array.from({ length: 40 }, (_, i) => gate.acquire(`key-${i % 3}`)),
    );

    // Not one refusal — this is what makes the first deploy safe by construction.
    expect(results.every((r) => r.ok)).toBe(true);
    // …and the instance is genuinely carrying more than the ceiling, because nothing
    // was held back.
    expect(gate.inFlight).toBeGreaterThan(gate.ceiling);

    await new Promise((r) => setTimeout(r, 60)); // let the simulated waits resolve
    expect(gate.wouldShed.requests).toBeGreaterThan(0);
    results.forEach((r) => r.ok && r.release());
  });

  it("costs the caller nothing — no request is held for the wait interval", async () => {
    tagAc(AC_SHADOW);
    const gate = new EmissionGate({ poolMax: 4, mode: "shadow", waitMs: 5_000 });
    const startedAt = Date.now();
    await Promise.all(Array.from({ length: 20 }, () => gate.acquire("loud")));
    // With a 5s interval, option (b) would have taken seconds here. Shadow must not.
    expect(Date.now() - startedAt).toBeLessThan(100);
  });

  it("counts nothing when there is nothing to count", async () => {
    tagAc(AC_SHADOW);
    const gate = new EmissionGate({ poolMax: 8, mode: "shadow" });
    const a = await gate.acquire("quiet");
    expect(a.ok).toBe(true);
    await settle();
    expect(gate.wouldShed.requests).toBe(0);
  });

  it("the WAIT runs in shadow too — a would-be waiter that gets a slot is not a shed", async () => {
    tagAc(AC_SHADOW);
    // The distinction that makes the number trustworthy. Under enforcing, a request that
    // arrives to a full cap and is served 30ms later is NOT shed. If shadow counted it,
    // the measurement would describe hard shed — the mechanism dec-4 rejected — and ac-2's
    // budget would be set from the wrong distribution.
    const gate = new EmissionGate({ poolMax: 4, mode: "shadow", waitMs: 200 });
    const held = await Promise.all([gate.acquire("a"), gate.acquire("b")]); // fills the sim
    const late = await gate.acquire("c"); // admitted for real; queued in the simulation
    expect(late.ok).toBe(true);

    held[0]!.ok && held[0]!.release(); // frees a simulated slot well inside the interval
    await new Promise((r) => setTimeout(r, 60));

    expect(gate.wouldShed.requests).toBe(0); // it would have been SERVED, not shed
    held.forEach((r) => r.ok && r.release());
    late.ok && late.release();
  });

  it("…and one that would have timed out IS counted", async () => {
    tagAc(AC_SHADOW);
    const gate = new EmissionGate({ poolMax: 4, mode: "shadow", waitMs: 30 });
    const held = await Promise.all([gate.acquire("a"), gate.acquire("b")]);
    await gate.acquire("c"); // nothing frees; the simulated waiter expires
    await new Promise((r) => setTimeout(r, 80));
    expect(gate.wouldShed.requests).toBe(1);
    held.forEach((r) => r.ok && r.release());
  });

  it("keeps no per-key state past release — shadow must not reintroduce growth", async () => {
    tagAc(AC_SHADOW);
    // The single most likely way to break t-1 from inside t-3. ac-11's bound holds
    // because an entry exists only while its key holds a slot; a shadow counter that
    // outlived a release would restore the unbounded caller-controlled map on a route
    // reached BEFORE authentication, where minting fresh tokens is free.
    const gate = new EmissionGate({ poolMax: 4, mode: "shadow", waitMs: 5 });
    for (let i = 0; i < 5_000; i++) {
      const a = await gate.acquire(`rotating-${i}`);
      if (a.ok) a.release();
    }
    await new Promise((r) => setTimeout(r, 30));
    expect(gate.trackedKeys).toBe(0);
    expect(gate.inFlight).toBe(0);
  });
});

describe("spec-525 ac-14: the shadow count says WHY, in the enforcing vocabulary", () => {
  it("labels a would-be shed with the same ShedCause the enforcing path returns", async () => {
    tagAc(AC_LABELS);
    tagAc(AC_SHADOW);
    // Shadow and enforcing data must be directly comparable — the whole point of measuring
    // first. A parallel labelling would make the week of shadow data unusable the moment
    // enforcement went on.
    const gate = new EmissionGate({ poolMax: 4, mode: "shadow", waitMs: 10 });
    const held = await Promise.all([gate.acquire("a"), gate.acquire("b")]);
    await gate.acquire("c"); // instance is simulated-full → ceiling
    await gate.acquire("a"); // "a" already holds its whole slice → slice
    await new Promise((r) => setTimeout(r, 40));

    expect(gate.wouldShed.requestsByCause.instance_ceiling_full).toBeGreaterThan(0);
    expect(gate.wouldShed.requestsByCause.key_slice_full).toBeGreaterThan(0);
    expect(gate.wouldShed.requests).toBe(
      gate.wouldShed.requestsByCause.instance_ceiling_full + gate.wouldShed.requestsByCause.key_slice_full,
    );
    held.forEach((r) => r.ok && r.release());
  });

  it("an ENFORCING gate reports the same causes, so the two datasets line up", async () => {
    tagAc(AC_LABELS);
    const gate = new EmissionGate({ poolMax: 4, mode: "enforcing", waitMs: 5 });
    const held = await Promise.all([gate.acquire("a"), gate.acquire("b")]);
    const refused = await gate.acquire("c");
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      // Same vocabulary, same field name — not a shadow-only shape.
      expect(["key_slice_full", "instance_ceiling_full"]).toContain(refused.cause);
    }
    held.forEach((r) => r.ok && r.release());
  });
});

describe("spec-525 ac-17: switching modes is configuration, not code", () => {
  it("reads the mode from the environment", () => {
    tagAc(AC_SHADOW);
    expect(resolveGateMode({ MEMEX_EMISSION_GATE_MODE: "enforcing" })).toBe("enforcing");
    expect(resolveGateMode({ MEMEX_EMISSION_GATE_MODE: "shadow" })).toBe("shadow");
  });

  it("defaults to SHADOW, so a wiring mistake under-protects rather than enforcing untuned limits", () => {
    tagAc(AC_SHADOW);
    // t-6 must wire this into deploy.sh AND the canonical secret. Miss the wiring and prod
    // silently takes this default — so the default has to be the safe direction.
    expect(resolveGateMode({})).toBe("shadow");
    expect(DEFAULT_GATE_MODE).toBe("shadow");
    // An unrecognised value is not a licence to enforce.
    expect(resolveGateMode({ MEMEX_EMISSION_GATE_MODE: "ENFORCE" })).toBe("shadow");
    expect(resolveGateMode({ MEMEX_EMISSION_GATE_MODE: "" })).toBe("shadow");
  });

  it("exposes its effective mode, so the smoke check can assert what is actually running", () => {
    tagAc(AC_SHADOW);
    // t-9 needs this: a shadow gate and an enforcing gate both return 200 to a healthy
    // request, so the mode is invisible from outside until the instance is under load.
    expect(new EmissionGate({ poolMax: 4, mode: "shadow" }).mode).toBe("shadow");
    expect(new EmissionGate({ poolMax: 4, mode: "enforcing" }).mode).toBe("enforcing");
  });
});
