// spec-525 t-1 — the admission gate primitive: bounds only, no HTTP, no database.
//
// These tests are written against the PRIMITIVE, not the route, because the whole point
// of the gate is that it decides without touching the resource it protects. If any of
// this needed a database to test, the design would be wrong.

import { describe, it, expect } from "vitest";
import { tagAc } from "@memex-ai-ac/vitest";
import { EmissionGate, deriveCeiling, derivePerKeySlice } from "./emission-gate.js";
import { resolvePoolMax, DEFAULT_POOL_MAX } from "../../db/pool-size.js";

const SPEC = "mindset-prod/memex-building-itself/specs/spec-525/acs";
const AC_PER_KEY = `${SPEC}/ac-9`; // keyed on a hash of the presented token, no lookup
const AC_FAIRNESS = `${SPEC}/ac-10`; // one loud key cannot consume another's share
const AC_BOUNDED = `${SPEC}/ac-11`; // the per-key structure cannot grow without limit
const AC_DERIVED = `${SPEC}/ac-12`; // both bounds exist and the ceiling is derived

/** Acquire `n` slots for one token, returning the successful releases. */
function acquireN(gate: EmissionGate, token: string, n: number) {
  const held: Array<() => void> = [];
  for (let i = 0; i < n; i++) {
    const a = gate.tryAcquire(token);
    if (a.ok) held.push(a.release);
  }
  return held;
}

describe("spec-525 ac-12: the ceiling is derived from the resolved pool, not typed", () => {
  it("resolvePoolMax reads DB_POOL_MAX and defaults to the value connection.ts uses", () => {
    tagAc(AC_DERIVED);
    expect(resolvePoolMax({ DB_POOL_MAX: "8" })).toBe(8);
    expect(resolvePoolMax({ DB_POOL_MAX: "4" })).toBe(4);
    // Unset → the same default the pool itself falls back to. The code default is 5;
    // 4 is the PROD override carried in the memex-<env>-deploy-env secret, so a gate
    // hardcoding 4 would be wrong everywhere except prod.
    expect(resolvePoolMax({})).toBe(DEFAULT_POOL_MAX);
    expect(DEFAULT_POOL_MAX).toBe(5);
  });

  it("resolvePoolMax rejects junk rather than propagating NaN into the ceiling", () => {
    tagAc(AC_DERIVED);
    // connection.ts used a bare Number(), so DB_POOL_MAX=abc yielded NaN. A NaN ceiling
    // compares false against everything, which would silently admit without limit.
    for (const junk of ["abc", "", "0", "-3", "1e309"]) {
      expect(resolvePoolMax({ DB_POOL_MAX: junk })).toBe(DEFAULT_POOL_MAX);
    }
  });

  it("the ceiling FOLLOWS the pool when the pool changes — not a literal that matches today", () => {
    tagAc(AC_DERIVED);
    // The structural guarantee: emission can never hold more than half an instance's
    // connections, so user traffic always retains some.
    expect(deriveCeiling(4)).toBe(2); // prod
    expect(deriveCeiling(5)).toBe(2); // code default — floor, never round up
    expect(deriveCeiling(8)).toBe(4);
    expect(deriveCeiling(20)).toBe(10);
    // Never zero: a pool of 1 must still admit one emission at a time, or the route is
    // closed rather than protected.
    expect(deriveCeiling(1)).toBe(1);
    expect(deriveCeiling(2)).toBe(1);
  });

  it("a gate built from a pool exposes a ceiling that is strictly less than the pool", () => {
    tagAc(AC_DERIVED);
    for (const poolMax of [2, 4, 5, 8, 16]) {
      const gate = new EmissionGate({ poolMax });
      expect(gate.ceiling).toBeLessThan(poolMax);
      expect(gate.ceiling).toBeGreaterThanOrEqual(1);
    }
  });

  it("BOTH bounds exist: the per-key slice is strictly below the instance ceiling", () => {
    tagAc(AC_DERIVED);
    tagAc(AC_FAIRNESS);
    // A per-key slice equal to the ceiling would let one key take everything, which is
    // ac-10's failure. Strictly-below is what leaves room for a second credential.
    for (const poolMax of [4, 5, 8, 16]) {
      const gate = new EmissionGate({ poolMax });
      expect(gate.perKeySlice).toBeLessThan(gate.ceiling);
      expect(gate.perKeySlice).toBeGreaterThanOrEqual(1);
      expect(derivePerKeySlice(gate.ceiling)).toBe(gate.perKeySlice);
    }
  });
});

describe("spec-525 ac-9: keyed on the presented token, by string handling alone", () => {
  it("admits two distinct tokens independently, with neither resolved to a memex", () => {
    tagAc(AC_PER_KEY);
    const gate = new EmissionGate({ poolMax: 8 }); // ceiling 4, slice 3
    const a = gate.tryAcquire("mxk_alpha");
    const b = gate.tryAcquire("mxk_beta");
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    expect(gate.inFlight).toBe(2);
    // Two tokens, two independent counters — established without any lookup.
    expect(gate.trackedKeys).toBe(2);
  });

  it("never stores the presented token in the clear", () => {
    tagAc(AC_PER_KEY);
    const gate = new EmissionGate({ poolMax: 8 });
    const secret = "mxk_this_must_not_be_retrievable";
    const a = gate.tryAcquire(secret);
    expect(a.ok).toBe(true);
    // The structure holds a hash. Serialising the whole gate must not reveal the
    // credential — the gate runs BEFORE authentication, so it handles unverified
    // secrets from unauthenticated callers and must not become a place they leak from.
    expect(JSON.stringify(gate.debugState())).not.toContain(secret);
    expect(JSON.stringify(gate.debugState())).not.toContain("this_must_not_be");
  });

  it("treats the same token as the same key, and different tokens as different keys", () => {
    tagAc(AC_PER_KEY);
    const gate = new EmissionGate({ poolMax: 4 }); // ceiling 2, slice 1
    const first = gate.tryAcquire("same-token");
    expect(first.ok).toBe(true);
    // Same token again → its slice (1) is full.
    expect(gate.tryAcquire("same-token")).toMatchObject({ ok: false });
    // A different token is unaffected.
    expect(gate.tryAcquire("other-token").ok).toBe(true);
  });

  it("an absent or empty credential is still bounded, not exempt", () => {
    tagAc(AC_PER_KEY);
    // The gate runs before authentication, so an unauthenticated caller reaches it.
    // Bucketing them all under one key means they contend with each other, never with
    // a real credential's slice, and can never bypass the bound by omitting the header.
    const gate = new EmissionGate({ poolMax: 4 });
    expect(gate.tryAcquire("").ok).toBe(true);
    expect(gate.tryAcquire("")).toMatchObject({ ok: false });
  });
});

describe("spec-525 ac-10: one loud credential cannot consume another's share", () => {
  it("a key that saturates its slice is shed while a second key is still admitted", () => {
    tagAc(AC_FAIRNESS);
    const gate = new EmissionGate({ poolMax: 8 }); // ceiling 4, slice 3
    const loud = acquireN(gate, "mxk_loud", 10);
    expect(loud).toHaveLength(gate.perKeySlice); // it got its slice and no more

    const refused = gate.tryAcquire("mxk_loud");
    expect(refused).toMatchObject({ ok: false, cause: "key_slice_full" });

    // …and in the SAME window, the quiet tenant still gets in. This is the criterion a
    // per-instance-only cap would fail — and with one emitter at ~90% of ingest load,
    // failing it means shedding the tenants that were not the problem.
    const quiet = gate.tryAcquire("mxk_quiet");
    expect(quiet).toMatchObject({ ok: true });
  });

  it("distinguishes WHY it refused: own slice full vs instance saturated", () => {
    tagAc(AC_FAIRNESS);
    // Those mean opposite things — one emitter over-emitting, versus the instance
    // genuinely saturated — and drive opposite responses (ac-14 labels the counter
    // with this).
    const gate = new EmissionGate({ poolMax: 4 }); // ceiling 2, slice 1
    gate.tryAcquire("a");
    expect(gate.tryAcquire("a")).toMatchObject({ cause: "key_slice_full" });

    gate.tryAcquire("b"); // instance now at its ceiling of 2
    expect(gate.tryAcquire("c")).toMatchObject({ cause: "instance_ceiling_full" });
  });

  it("the instance ceiling holds however many distinct keys turn up", () => {
    tagAc(AC_FAIRNESS);
    // Per-key slices SUM, so without an overall ceiling the pool is unprotected once
    // enough credentials appear. Twenty keys must not open twenty connections' worth.
    const gate = new EmissionGate({ poolMax: 8 }); // ceiling 4
    let admitted = 0;
    for (let i = 0; i < 20; i++) {
      if (gate.tryAcquire(`key-${i}`).ok) admitted++;
    }
    expect(admitted).toBe(gate.ceiling);
    expect(gate.inFlight).toBe(gate.ceiling);
  });

  it("releasing returns the slot to both bounds", () => {
    tagAc(AC_FAIRNESS);
    const gate = new EmissionGate({ poolMax: 4 }); // ceiling 2, slice 1
    const a = gate.tryAcquire("a");
    const b = gate.tryAcquire("b");
    expect(gate.tryAcquire("c")).toMatchObject({ ok: false });
    if (a.ok) a.release();
    expect(gate.tryAcquire("c")).toMatchObject({ ok: true });
    if (b.ok) b.release();
  });

  it("a double release cannot manufacture capacity", () => {
    tagAc(AC_FAIRNESS);
    // A middleware with an error path can plausibly call release twice; if that
    // decremented twice the gate would drift open under exactly the load it guards.
    const gate = new EmissionGate({ poolMax: 4 });
    const a = gate.tryAcquire("a");
    expect(a.ok).toBe(true);
    if (a.ok) {
      a.release();
      a.release();
      a.release();
    }
    expect(gate.inFlight).toBe(0);
    const held = acquireN(gate, "x", 10).length + acquireN(gate, "y", 10).length;
    expect(held).toBe(gate.ceiling);
  });
});

describe("spec-525 ac-11: the per-key structure cannot grow without limit", () => {
  it("holds no entry for a key with nothing in flight", () => {
    tagAc(AC_BOUNDED);
    const gate = new EmissionGate({ poolMax: 8 });
    const a = gate.tryAcquire("transient");
    expect(gate.trackedKeys).toBe(1);
    if (a.ok) a.release();
    // The counter exists only while the key holds something. Retaining it would be the
    // growth surface — and this is a public route reached BEFORE authentication, so the
    // set of distinct keys is caller-controlled and unbounded by nature.
    expect(gate.trackedKeys).toBe(0);
  });

  it("driving far more distinct keys than the ceiling holds the structure's size", () => {
    tagAc(AC_BOUNDED);
    const gate = new EmissionGate({ poolMax: 8 }); // ceiling 4
    for (let i = 0; i < 50_000; i++) gate.tryAcquire(`rotating-key-${i}`);
    // A rotating-token flood is the attack: mint distinct credentials, grow the map.
    // Size is bounded by what is actually in flight, never by how many keys were seen.
    expect(gate.trackedKeys).toBeLessThanOrEqual(gate.ceiling);
    expect(gate.trackedKeys).toBe(gate.inFlight);
  });

  it("a refused acquisition leaves no trace", () => {
    tagAc(AC_BOUNDED);
    const gate = new EmissionGate({ poolMax: 4 }); // ceiling 2
    acquireN(gate, "holder-a", 1);
    acquireN(gate, "holder-b", 1);
    const before = gate.trackedKeys;
    for (let i = 0; i < 1000; i++) gate.tryAcquire(`refused-${i}`);
    expect(gate.trackedKeys).toBe(before);
  });

  it("declares a hard cap on tracked keys as a backstop", () => {
    tagAc(AC_BOUNDED);
    // The structural bound above is the real defence. This asserts the gate ALSO
    // states an explicit maximum, so a future change that retains state past release
    // (a wait queue, a rate window) cannot quietly reintroduce unbounded growth.
    const gate = new EmissionGate({ poolMax: 8 });
    expect(gate.maxTrackedKeys).toBeGreaterThanOrEqual(gate.ceiling);
    expect(Number.isFinite(gate.maxTrackedKeys)).toBe(true);
  });
});
