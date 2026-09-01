// spec-545 t-2 — std-22 portability guard over the default facet vocabulary (ac-8).
//
// The sibling of default-standards.portability.test.ts, sharing its deny-list via
// ./portability-scan.ts. The facet vocabulary is seeded into every owner at
// provisioning and its descriptions are handed verbatim to an agent working on a
// codebase we cannot see, so the same std-22 rule binds: no language, framework, file
// path, tool, project symbol, or entity handle.
//
// SCOPED TO THE WHOLE FIXTURE, not the two entries spec-545 edits. The point of a guard
// is the edit it catches AFTER this Spec ships — a check that only looked at
// `architecture` and `code-style` would wave through the next description someone
// writes.

import { describe, it, expect } from "vitest";
import { tagAc } from "@memex-ai-ac/vitest";
import { DEFAULT_FACETS } from "./default-facets.fixture.js";
import { scanForNonPortableTokens, type Scannable } from "./portability-scan.js";

const AC = (n: number) => `mindset-prod/memex-building-itself/specs/spec-545/acs/ac-${n}`;

// This fixture's adapter: a facet contributes its display name and its description.
// The stable `key` is deliberately NOT scanned — it is a slug, not prose, and it is
// pinned separately as a contract (ac-9).
function scannableStrings(): Scannable[] {
  return DEFAULT_FACETS.flatMap((facet) => [
    { where: `${facet.key} / name`, text: facet.name },
    { where: `${facet.key} / description`, text: facet.description },
  ]);
}

describe("spec-545: the default facet vocabulary is std-22-portable (ac-8)", () => {
  it("contains no path, tooling, language, project-symbol, or handle tokens", () => {
    tagAc(AC(8));

    const violations = scanForNonPortableTokens(scannableStrings());

    expect(violations, `Non-portable tokens found:\n${violations.join("\n")}`).toEqual([]);
  });

  it("scans every entry, so a future description edit trips it too", () => {
    tagAc(AC(8));
    // Guards the guard's SCOPE rather than its patterns (the shared canary covers
    // those): if someone narrows the adapter to the entries this Spec touched, the
    // string count collapses and this fails.
    expect(scannableStrings()).toHaveLength(DEFAULT_FACETS.length * 2);
  });
});
