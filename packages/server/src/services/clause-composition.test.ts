// spec-150 t-3 — the derived-content projection (pure). Verifies that a section's
// stored `content` is the byte-exact composition of its preamble + clauses in
// position order, which is the lever the transparency contract rests on (ac-9,
// ac-21). DB-free: composeSectionContent is a pure function.

import { describe, it, expect } from "vitest";
import { tagAc } from "@memex-ai-ac/vitest";
import {
  composeSectionContent,
  splitSectionIntoClauses,
  type ComposableClause,
} from "./clause-composition.js";

const AC = (n: number) =>
  `mindset-prod/memex-building-itself/specs/spec-150/acs/ac-${n}`;

const clause = (position: number, body: string): ComposableClause => ({ position, body });

describe("spec-150 t-3: composeSectionContent (ac-9 — deterministic composition)", () => {
  it("a section with no clauses composes to its preamble alone", () => {
    tagAc(AC(9));
    expect(composeSectionContent("Just prose, no clauses.", [])).toBe(
      "Just prose, no clauses.",
    );
  });

  it("composes preamble + clause bodies by ascending position, no inserted separator", () => {
    tagAc(AC(9));
    const out = composeSectionContent("Intro.\n\n", [
      clause(1, "- A\n"),
      clause(2, "- B\n"),
    ]);
    expect(out).toBe("Intro.\n\n- A\n- B\n");
  });

  it("orders by position regardless of array order", () => {
    tagAc(AC(9));
    const inOrder = composeSectionContent("P\n", [clause(1, "x"), clause(2, "y"), clause(3, "z")]);
    const shuffled = composeSectionContent("P\n", [clause(3, "z"), clause(1, "x"), clause(2, "y")]);
    expect(shuffled).toBe(inOrder);
    expect(shuffled).toBe("P\nxyz");
  });

  it("is deterministic — identical inputs give identical output", () => {
    tagAc(AC(9));
    const args = ["pre", [clause(2, "b"), clause(1, "a")]] as const;
    expect(composeSectionContent(...args)).toBe(composeSectionContent(...args));
  });

  it("does not mutate the input clause array (immutability)", () => {
    tagAc(AC(9));
    const clauses = [clause(2, "b"), clause(1, "a")];
    const before = clauses.map((c) => c.position);
    composeSectionContent("p", clauses);
    expect(clauses.map((c) => c.position)).toEqual(before);
  });
});

describe("spec-150 t-3: projection is byte-identical to the original (ac-21)", () => {
  // The migration (t-6) partitions a section's content into preamble + contiguous
  // clause slices. Because composition is exact concatenation, re-composing those
  // parts reproduces the original bytes — that round-trip is what keeps embed / FTS
  // / export unchanged. Here we assert the concatenation half over realistic shapes;
  // the split-then-compose round-trip over real standards lands in t-6.
  it.each([
    {
      name: "std-17-style Rule section (preamble + bullet clauses)",
      preamble: "Every change obeys these invariants.\n\n",
      clauses: [
        clause(1, "- Every surface-touching change MUST extend the smoke suite.\n"),
        clause(2, "- Smoke hits the live host over real HTTP.\n"),
        clause(3, "- Two tiers: public and authed, guard-railed to a smoke namespace.\n"),
      ],
      expected:
        "Every change obeys these invariants.\n\n" +
        "- Every surface-touching change MUST extend the smoke suite.\n" +
        "- Smoke hits the live host over real HTTP.\n" +
        "- Two tiers: public and authed, guard-railed to a smoke namespace.\n",
    },
    {
      name: "leading whitespace + trailing newline preserved exactly",
      preamble: "  \n## Rule\n\n",
      clauses: [clause(1, "1. first\n"), clause(2, "2. second")],
      expected: "  \n## Rule\n\n1. first\n2. second",
    },
  ])("re-composes $name byte-for-byte", ({ preamble, clauses, expected }) => {
    tagAc(AC(21));
    expect(composeSectionContent(preamble, clauses)).toBe(expected);
  });
});

describe("spec-150 t-3/t-6: split is the byte-exact inverse of compose (ac-21)", () => {
  // compose(split(content)) === content for ANY content — this round-trip is the
  // guarantee that decomposing a section never changes its stored bytes, so embed /
  // FTS / export are untouched.
  it.each([
    "Intro.\n\n- A\n- B\n",
    "- bullet, no preamble\n",
    "no list items at all, just prose",
    "Lead.\n\n1. one\n2. two\n\nclosing prose, no trailing newline",
    "Multi\nline preamble.\n\n- clause with\n  a continuation line\n- next clause\n",
    "* star bullets\n+ plus bullet\n",
    "Numbered with paren.\n\n1) first\n2) second\n",
    "",
    "\n\n",
  ])("round-trips %j", (content) => {
    tagAc(AC(21));
    const { preamble, clauses } = splitSectionIntoClauses(content);
    const recomposed = composeSectionContent(
      preamble,
      clauses.map((body, i) => ({ position: i + 1, body })),
    );
    expect(recomposed).toBe(content);
  });

  it("partitions a std-17-style Rule section into preamble + one clause per bullet", () => {
    tagAc(AC(21));
    const content =
      "Every change obeys these invariants.\n\n" +
      "- Every surface-touching change MUST extend the smoke suite.\n" +
      "- Smoke hits the live host over real HTTP.\n";
    const { preamble, clauses } = splitSectionIntoClauses(content);
    expect(preamble).toBe("Every change obeys these invariants.\n\n");
    expect(clauses).toEqual([
      "- Every surface-touching change MUST extend the smoke suite.\n",
      "- Smoke hits the live host over real HTTP.\n",
    ]);
  });
});
