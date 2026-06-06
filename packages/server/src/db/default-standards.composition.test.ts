// spec-184 ac-4 / ac-5 — the starter set is BALANCED: it ships at least one
// METHODOLOGY Standard (the kind the agent surfaces while the user shapes their first
// Spec) AND at least one Standard that governs the user's OWN code. A pure-unit guard
// over the fixture's `category` metadata that locks the set's composition, so a later
// trim can't drop either half and quietly violate ac-4 / ac-5.
//
// Scope note: this verifies the testable precondition — that such Standards are PRESENT
// in the seeded set. The behavioural half of ac-4 (the agent actually surfacing a
// Standard during draft→specify→build) is existing Memex platform behaviour, not introduced
// or changed by spec-184, so it is verified by inspection rather than re-tested here.

import { describe, it, expect } from "vitest";
import { tagAc } from "@memex-ai-ac/vitest";
import { DEFAULT_STANDARDS } from "./default-standards.fixture.js";

const AC = (n: number) =>
  `mindset-prod/memex-building-itself/specs/spec-184/acs/ac-${n}`;

describe("spec-184: the default Standards set is balanced (ac-4 / ac-5)", () => {
  it("ships at least one methodology Standard the agent surfaces during spec work (ac-4)", () => {
    tagAc(AC(4));
    const methodology = DEFAULT_STANDARDS.filter((s) => s.category === "methodology");
    expect(methodology.length).toBeGreaterThanOrEqual(1);
    // Spec-Driven Development is the flagship methodology Standard.
    expect(methodology.map((s) => s.key)).toEqual(
      expect.arrayContaining(["spec-driven-development"]),
    );
  });

  it("ships at least one Standard that governs the user's own code (ac-5)", () => {
    tagAc(AC(5));
    const codeGoverning = DEFAULT_STANDARDS.filter((s) => s.category === "code-example");
    expect(codeGoverning.length).toBeGreaterThanOrEqual(1);
    // e.g. the "every behavioural change ships with a test" Standard binds real code.
    expect(codeGoverning.map((s) => s.key)).toEqual(
      expect.arrayContaining(["every-change-ships-with-a-test"]),
    );
  });
});
