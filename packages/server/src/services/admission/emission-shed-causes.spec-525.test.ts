// spec-525 t-16 / ac-26 — the cause vocabulary is RUNTIME DATA, so a new cause cannot be
// silently omitted from a count.
//
// THE DEFECT THIS PINS, found while costing dec-6's two-term bound rather than in review.
// `ShedCause` was a bare type union of two strings, and every consumer enumerated those
// two BY HAND:
//
//   emission-gate.ts      #wouldShedEventsByCause  = { key_slice_full: 0, instance_ceiling_full: 0 }
//   emission-shed-log.ts  const zero               = { key_slice_full: 0, instance_ceiling_full: 0 }
//   emission-shed-log.ts  wouldShedEventsByCause   = { key_slice_full: now.… - before.…,
//                                                      instance_ceiling_full: now.… - before.… }
//   observability/otel    readonly cause: "key_slice_full" | "instance_ceiling_full"
//                         — a THIRD copy of the union, in another module
//   TWO test files        expect(e.key_slice_full + e.instance_ceiling_full).toBe(total)
//   ONE more test file    eventsByCause: { key_slice_full: n, instance_ceiling_full: 0 }
//
// And the sites split cleanly in two, which is the lesson worth keeping:
//
//   - the LITERAL maps and the duplicated union are caught by `tsc`. Adding the third
//     cause made `make typecheck` red at five sites in three files, and fixing them was
//     mechanical.
//   - the SUM assertions are invisible to `tsc`. Summing two keys of a three-key record
//     is perfectly well typed. `vitest` was GREEN on the same tree the compiler rejected,
//     and it would have stayed green on a wrong total forever.
//
// So iteration is not a tidiness preference over a literal — it is the only form the
// second class of site has. (Three further test files name a SINGLE cause on purpose,
// asserting WHICH bound refused. Those are unaffected by a new member and were left.)
//
// dec-6 adds a third cause. Against that shape, each of those sites fails DIFFERENTLY and
// none of them fails loudly:
//
//   - the gate's zero maps: a missing key reads `undefined`, so `+=` yields NaN
//   - the heartbeat's delta: the new cause is **dropped from the published window
//     entirely** — the instrument t-10 reads simply never mentions it. No error, no gap,
//     no clue. This is the worst of the four and it is not a test at all.
//   - the tests: they keep PASSING while summing two causes out of three, so a green
//     suite certifies a wrong total.
//
// That last one is the trap worth naming: those assertions were written to sum ACROSS
// causes precisely so they would not test the fixture (`emission-shed-unit.spec-525`
// explains why). Summing across a NAMED PAIR looked like the general form and is not —
// it is the same events-vs-requests axis confusion that produced t-12's ~8x under-report
// and the budget guard's phantom `+1`, in a third costume.
//
// So the vocabulary becomes data: one exported array, the type derived FROM it, every
// zero map and every delta built by iterating it, and these assertions comparing key
// SETS rather than named keys. After this, adding a cause moves every count with it or
// goes red — it can no longer go quiet.

import { describe, it, expect } from "vitest";
import { tagAc } from "@memex-ai-ac/vitest";
import { EmissionGate, SHED_CAUSES, zeroByCause } from "./emission-gate.js";

const SPEC = "mindset-prod/memex-building-itself/specs/spec-525/acs";
const AC_TOTAL_AGNOSTIC = `${SPEC}/ac-26`;

/** Sum a by-cause record over the VOCABULARY, never over a named pair. */
const sumOverVocabulary = (byCause: Record<string, number>): number =>
  SHED_CAUSES.reduce((acc, cause) => acc + byCause[cause], 0);

describe("spec-525 ac-26: the cause vocabulary is data, not a hand-copied pair", () => {
  it("exposes every cause as a runtime array the type is derived from", () => {
    tagAc(AC_TOTAL_AGNOSTIC);

    // A type union cannot be iterated at runtime, which is why four sites enumerated it
    // by hand. This is the fix's load-bearing half: one place to add a cause.
    expect(Array.isArray(SHED_CAUSES)).toBe(true);
    expect(SHED_CAUSES.length).toBeGreaterThanOrEqual(2);
    expect(new Set(SHED_CAUSES).size).toBe(SHED_CAUSES.length);
    // The two the enforcing path has always returned must still be in the vocabulary —
    // a rename would invalidate the shadow window t-13 already read.
    expect(SHED_CAUSES).toContain("key_slice_full");
    expect(SHED_CAUSES).toContain("instance_ceiling_full");
  });

  it("builds a zero map with exactly one entry per cause — no more, no fewer", () => {
    tagAc(AC_TOTAL_AGNOSTIC);

    const zero = zeroByCause();
    expect(Object.keys(zero).sort()).toEqual([...SHED_CAUSES].sort());
    expect(Object.values(zero).every((n) => n === 0)).toBe(true);
  });

  it("the gate's by-cause counters carry EVERY cause, so a `+=` can never hit undefined", () => {
    tagAc(AC_TOTAL_AGNOSTIC);

    // The failure this rules out is arithmetic, not a missing label: `undefined + 1` is
    // NaN, and NaN propagates silently through every comparison the gate makes.
    const gate = new EmissionGate({ poolMax: 4, mode: "shadow", waitMs: 0 });
    expect(Object.keys(gate.wouldShed.eventsByCause).sort()).toEqual([...SHED_CAUSES].sort());
    expect(Object.keys(gate.wouldShed.requestsByCause).sort()).toEqual([...SHED_CAUSES].sort());
  });

  it("reconciles both axes against the vocabulary, not against two named causes", async () => {
    tagAc(AC_TOTAL_AGNOSTIC);

    // Drive sheds on more than one cause: two keys fill the simulated ceiling (2 at
    // poolMax 4), a third key then hits the ceiling, and a repeat of "a" hits its own
    // slice. Weighted so the two axes cannot be confused for one another.
    const gate = new EmissionGate({ poolMax: 4, mode: "shadow", waitMs: 10 });
    const held = await Promise.all([gate.acquire("a", 3), gate.acquire("b", 3)]);
    await gate.acquire("c", 5);
    await gate.acquire("a", 7);
    await new Promise((r) => setTimeout(r, 40));

    const { events, requests, eventsByCause, requestsByCause } = gate.wouldShed;

    // THE assertion, and the reason it is written this way: an assertion naming
    // `key_slice_full + instance_ceiling_full` stays green while a third cause absorbs
    // sheds neither term counts. Iterating the vocabulary cannot.
    expect(sumOverVocabulary(eventsByCause)).toBe(events);
    expect(sumOverVocabulary(requestsByCause)).toBe(requests);
    // And the fixture really did shed on both axes — otherwise the sums above are 0 === 0.
    expect(events).toBeGreaterThan(0);
    expect(requests).toBeGreaterThan(0);
    expect(events).toBeGreaterThan(requests); // weights > 1, so the axes must differ

    held.forEach((r) => r.ok && r.release());
  });

  it("every cause an ENFORCING gate returns is in the vocabulary", async () => {
    tagAc(AC_TOTAL_AGNOSTIC);

    // The other direction of the same contract: a cause the gate can return but the
    // vocabulary does not list would make every iterating count under-report — the exact
    // defect, mirrored. Shadow and enforcing must share one vocabulary (ac-14).
    const gate = new EmissionGate({ poolMax: 4, mode: "enforcing", waitMs: 0 });
    const held = [gate.tryAcquire("a"), gate.tryAcquire("b"), gate.tryAcquire("c")];
    const refusals = held.filter((r) => !r.ok);

    expect(refusals.length).toBeGreaterThan(0);
    for (const r of refusals) {
      if (!r.ok) expect(SHED_CAUSES).toContain(r.cause);
    }
    held.forEach((r) => r.ok && r.release());
  });
});
