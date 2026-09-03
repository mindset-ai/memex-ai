// spec-525 t-16 / ac-24 — dec-7: the per-key allowance is a bounded SHARE of the ceiling,
// never a decrement of it.
//
// WHAT WAS WRONG. `derivePerKeySlice(ceiling) = max(1, ceiling - 1)` yields exactly **1**
// at prod's ceiling of 2, so a credential's SECOND concurrent request is refused — and
// t-13 measured that this signs **99.0%** of every would-be refusal over 8 days of
// production. The share was not badly chosen; it was derived by subtraction, which
// collapses at small ceilings.
//
// WHY THIS TEST LOOKS LIKE A COMPROMISE, AND IS NOT. dec-7 found that the obvious fix
// contradicts a criterion that is already verified:
//
//   ac-10 (6 passing tests) : a key that has saturated its share still leaves room for a
//                             second credential          ->  allowance <= ceiling - 1
//   ac-24 (this one)        : a key gets at least 2 at once  ->  allowance >= 2
//
// At ceiling 2 those admit NO common value. That is arithmetic, not a formula problem: two
// slots, and fairness keeps one free, so each credential gets one. dec-7 resolved to keep
// ac-10 unconditionally and make the floor conditional on the ceiling — so this test
// asserts BOTH bounds over a RANGE, and pins the ceiling-2 case at 1 deliberately.
//
// A test asserting "always at least 2" would assert something the deployment cannot
// satisfy. A test checking only prod's shape would miss the entire improvement. Neither is
// a test of dec-7's resolution.
//
// WHERE THE IMPROVEMENT COMES FROM, since it is not from this file: the ceiling reaching 3,
// which needs `DB_POOL_MAX >= 6`. Two corrections on that, both from measurement rather
// than from prose (c-23, c-24):
//
//   - NOT t-15, which frees 4 connections and moves the achievable pool size not at all.
//   - NOT spec-518 either, which is `done` and never owned the pool. `db/connection.ts`
//     names **spec-332**, which is alive in `specify` — and whose dec-3 has ALREADY
//     resolved "REGIME 1 — Stopgap: REJECTED. DB_POOL_MAX stays at 5 (pre-MCP bump capped
//     at ~6, marginal)". Its premise has moved since (it reasons against
//     max_connections=50; prod has run 200 since 2026-08-12), so the path is a
//     re-grounding of dec-3, not a raise anyone can ask for.

import { describe, it, expect } from "vitest";
import { tagAc } from "@memex-ai-ac/vitest";
import { deriveCeiling, derivePerKeySlice, EmissionGate } from "./emission-gate.js";

const SPEC = "mindset-prod/memex-building-itself/specs/spec-525/acs";
const AC_PER_KEY_SHARE = `${SPEC}/ac-24`;
const AC_FAIRNESS = `${SPEC}/ac-10`; // the criterion dec-7 refused to bend

/** Every pool size a deployment could plausibly hold, not one fixture value. */
const POOL_SIZES = [1, 2, 3, 4, 5, 6, 8, 10, 12, 16, 24, 32];

describe("spec-525 ac-24: the per-key allowance is a share, not a decrement", () => {
  it("stays strictly below the ceiling at EVERY pool size — ac-10, unconditionally", () => {
    tagAc(AC_PER_KEY_SHARE);
    tagAc(AC_FAIRNESS);

    // The bound dec-7 refused to trade. Asserted over the range because a share computed
    // from the ceiling could exceed `ceiling - 1` at some sizes and not others — which is
    // exactly the shape of bug a single fixture value hides.
    for (const poolMax of POOL_SIZES) {
      const ceiling = deriveCeiling(poolMax);
      const slice = derivePerKeySlice(ceiling);
      if (ceiling > 1) {
        expect(slice).toBeLessThanOrEqual(ceiling - 1);
      }
      // And never zero, at any size: an allowance of 0 does not ration the route, it
      // CLOSES it. `min(ceiling - 1, ...)` alone yields 0 at a ceiling of 1, which is a
      // real deployment shape (a pool of 1 or 2), so the outer floor of 1 is load-bearing
      // rather than defensive.
      expect(slice).toBeGreaterThanOrEqual(1);
    }
  });

  it("gives a credential at least 2 concurrent requests from ceiling 3 upward", () => {
    tagAc(AC_PER_KEY_SHARE);

    // The half that fixes the 99%. It cannot hold at ceiling 2 (see the header), so the
    // claim is conditional — and the condition is asserted, not assumed away.
    for (const poolMax of POOL_SIZES) {
      const ceiling = deriveCeiling(poolMax);
      if (ceiling >= 3) {
        expect(derivePerKeySlice(ceiling)).toBeGreaterThanOrEqual(2);
      }
    }

    // Asserted through the function, never against the constant. `MIN_PER_KEY_SLICE` is
    // module-private and stays that way: widening an export so a test can reach inside is
    // the thing std-51 forbids, and the floor is fully observable here anyway — a share
    // tweak that reintroduced an allowance of 1 at ceiling 3 fails the loop above.
    expect(derivePerKeySlice(3)).toBeGreaterThan(1);
  });

  it("is exactly 1 at prod's shape today, and that is the recorded consequence", () => {
    tagAc(AC_PER_KEY_SHARE);

    // Pinned on purpose. dec-7's cost is that nothing improves until the ceiling rises,
    // and a cost nobody can see in a test is a cost the next reader will assume was paid.
    expect(deriveCeiling(4)).toBe(2); // prod: DB_POOL_MAX = 4
    expect(derivePerKeySlice(2)).toBe(1);

    // The first size at which dec-7's improvement actually arrives, and the size the ask
    // on spec-518 targets: DB_POOL_MAX = 6.
    expect(deriveCeiling(6)).toBe(3);
    expect(derivePerKeySlice(3)).toBe(2);
  });

  it("no longer decrements: the share grows with the ceiling instead of trailing it by one", () => {
    tagAc(AC_PER_KEY_SHARE);

    // The behavioural difference from `max(1, ceiling - 1)`, which would have handed a
    // single credential nearly the whole room at a large ceiling — fairness dissolving
    // precisely where there is most to share.
    expect(derivePerKeySlice(deriveCeiling(16))).toBeLessThan(deriveCeiling(16) - 1);
    expect(derivePerKeySlice(deriveCeiling(32))).toBeLessThan(deriveCeiling(32) - 1);
  });

  it("the gate reports the derived allowance, so the heartbeat cannot disagree with it", async () => {
    tagAc(AC_PER_KEY_SHARE);

    // The number an operator reads in the 60s window is the one admission uses — not a
    // second copy. t-10 sets values off that window, so a divergence here would be a
    // knob turned against the wrong reading.
    const gate = new EmissionGate({ poolMax: 12, mode: "enforcing", waitMs: 0 });
    expect(gate.perKeySlice).toBe(derivePerKeySlice(gate.ceiling));
    expect(gate.perKeySlice).toBeGreaterThanOrEqual(2);

    // And it BINDS: one credential is refused at its share while another is still admitted
    // — ac-10's actual behaviour, at a ceiling where ac-24's floor is in force.
    const held = [];
    for (let i = 0; i < gate.perKeySlice; i++) held.push(gate.tryAcquire("loud", 1));
    expect(held.every((h) => h.ok)).toBe(true);

    const refused = gate.tryAcquire("loud", 1);
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.cause).toBe("key_slice_full");

    const quiet = await gate.acquire("quiet", 1);
    expect(quiet.ok).toBe(true);
    if (quiet.ok) quiet.release();
    held.forEach((h) => h.ok && h.release());
  });
});
