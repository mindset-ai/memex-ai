// spec-545 t-1 — the `architecture` / `code-style` wording contract (ac-6, ac-7).
//
// WHY THIS EXISTS. The facet `description` is the rubric an agent reads before casting
// the forced ballot on create_task, and the ballot is what routes a Standard's clauses
// into the agent's response. `architecture` described only a redesign ("how components
// are separated and how they communicate"), so an agent creating a file or widening
// what a module exposes honestly voted false — and std-51, which governs exactly that
// moment and is advisory (no check gates a merge on it), was never delivered.
//
// The reword lands on ground `code-style` already claimed ("file organization") whose
// tie-break arbitrated typing rules ONLY. Shipping the `architecture` half alone would
// leave two descriptions on the same ground with no arbiter — an inconsistent vote is
// worse than a consistently wrong one, so dec-1 made this a two-entry change.
//
// Assertions are over the imported constant: no DB, no network, no fixtures.
// The LIVE rows an agent actually reads are a separate, manual change (spec-545 t-5) —
// this file deliberately does NOT tag the scope ACs, because a fixture cannot prove
// anything about what is served.

import { describe, it, expect } from "vitest";
import { tagAc } from "@memex-ai-ac/vitest";
import { DEFAULT_FACETS } from "./default-facets.fixture.js";

const AC = (n: number) => `mindset-prod/memex-building-itself/specs/spec-545/acs/ac-${n}`;

function descriptionOf(key: string): string {
  const entry = DEFAULT_FACETS.find((f) => f.key === key);
  if (!entry) throw new Error(`spec-545: no facet with key '${key}' in DEFAULT_FACETS`);
  return entry.description;
}

describe("spec-545: the architecture facet describes everyday work (ac-6)", () => {
  it("names all three everyday cases the old wording excluded", () => {
    tagAc(AC(6));
    const description = descriptionOf("architecture");

    // One assertion per case, so a failure names WHICH case went missing rather than
    // reporting that a long string stopped matching.
    const everydayCases: { label: string; pattern: RegExp }[] = [
      { label: "creating a module or file", pattern: /creating a new module or file/i },
      {
        label: "adding to what a module exposes to its callers",
        pattern: /adding to what a module exposes to its callers/i,
      },
      { label: "moving code between places", pattern: /moving code from one place to another/i },
    ];

    const missing = everydayCases
      .filter(({ pattern }) => !pattern.test(description))
      .map(({ label }) => label);

    expect(
      missing,
      `architecture description does not name: ${missing.join("; ")}\n\nGot: ${description}`,
    ).toEqual([]);
  });

  it("leaves the governs-a-clause sentence byte-identical", () => {
    tagAc(AC(6));
    // The description serves the ballot AND the clause classifier, and every reader
    // gets the whole string (formatFacetList / renderFacetBallotBlock /
    // classifierSystemPrompt all interpolate it verbatim). Broadening the topic half
    // while leaving this half untouched is what keeps the change to one hypothesis.
    expect(descriptionOf("architecture")).toContain(
      "Governs a clause about where logic belongs or how pieces fit together.",
    );
  });
});

describe("spec-545: code-style arbitrates placement, not only typing (ac-7)", () => {
  it("no longer scopes its tie-break to typing rules alone", () => {
    tagAc(AC(7));
    const description = descriptionOf("code-style");

    // The exact sentence that made the collision unarbitrable: it sent typing rules to
    // architecture when they were about module boundaries, and said nothing at all
    // about where a file or a moved function belongs.
    expect(
      description,
      "code-style still carries the typing-only tie-break; placement remains unarbitrated",
    ).not.toMatch(/On a typing rule, prefer code-style unless/i);
  });

  it("sends structure and placement to architecture", () => {
    tagAc(AC(7));
    const description = descriptionOf("code-style");

    expect(
      description,
      "code-style's tie-break must name `architecture` as the destination for structural rules",
    ).toMatch(/architecture/);
    expect(
      description,
      "code-style's tie-break must speak to structure/placement, not only line-level style",
    ).toMatch(/structure|placement|where logic lives|offers its callers/i);
  });

  it("keeps code-style to what happens inside a file", () => {
    tagAc(AC(7));
    // The residual claim has to be narrow enough that the two descriptions stop
    // competing: `code-style` owns how code is written within a file, nothing wider.
    expect(descriptionOf("code-style")).toMatch(/inside a file|within a file/i);
  });
});
