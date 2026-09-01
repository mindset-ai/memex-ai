// spec-184 t-5 — std-22 portability guard over the default-Standards fixture.
//
// The six default Standards are seeded into a stranger's Memex over a codebase we
// can't see (spec-184). Per std-22 their text MUST NOT name a file path or layout, a
// language/framework, a test runner / build tool / package manager, a project-specific
// symbol, or a `std-N` handle — those would be meaningless (or wrong) in a customer's
// workspace. This test scans every title + clause and fails on any such token, so the
// fixture can't drift out of portability on a later edit. Verifies spec-184 ac-17.
//
// The deny-list itself moved to ./portability-scan.ts when spec-545 gave it a second
// consumer (the default facet vocabulary). What stays here is this fixture's adapter —
// how a Standard flattens into scannable strings — and this Spec's AC tags.

import { describe, it, expect } from "vitest";
import { tagAc } from "@memex-ai-ac/vitest";
import { DEFAULT_STANDARDS } from "./default-standards.fixture.js";
import { canarySamplesNotFlagged, scanForNonPortableTokens, type Scannable } from "./portability-scan.js";

const AC = (n: number) =>
  `mindset-prod/memex-building-itself/specs/spec-184/acs/ac-${n}`;

// Every scannable string in the fixture, with a location label for failure messages.
function scannableStrings(): Scannable[] {
  const out: Scannable[] = [];
  for (const std of DEFAULT_STANDARDS) {
    out.push({ where: `${std.key} / title`, text: std.title });
    for (const section of std.sections) {
      out.push({ where: `${std.key} / ${section.sectionType} / title`, text: section.title });
      section.clauses.forEach((c, i) => {
        out.push({ where: `${std.key} / ${section.sectionType} / cl[${i}]`, text: c });
      });
    }
  }
  return out;
}

describe("spec-184: default Standards are std-22-portable (ac-17)", () => {
  it("contains no path, tooling, language, project-symbol, or handle tokens", () => {
    tagAc(AC(17));
    tagAc(AC(3)); // scope ac-3: every default is portable per std-22

    const violations = scanForNonPortableTokens(scannableStrings());

    expect(violations, `Non-portable tokens found:\n${violations.join("\n")}`).toEqual([]);
  });

  it("the forbidden-token list itself catches a known-bad sample (guards the guard)", () => {
    tagAc(AC(17));
    // If a future refactor neuters the patterns, this canary names the sample that
    // stopped being caught.
    const unflagged = canarySamplesNotFlagged();
    expect(unflagged, `deny-list stopped flagging: ${unflagged.join("; ")}`).toEqual([]);
  });
});
