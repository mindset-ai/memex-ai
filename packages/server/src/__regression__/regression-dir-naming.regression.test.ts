// Regression guard (spec-392 ac-8): the __regression__ directory's filenames
// stay consistent so shard / glob selection agrees with itself.
//
// Two selectors pick "regression" tests, and they must agree on the same set:
//   - INFIX glob: `package.json` test:unit EXCLUDES `**/*.regression.test.ts`
//     (and the coverage config excludes the same infix). A test under
//     __regression__ that is a BARE `*.test.ts` — missing the `.regression.`
//     infix — leaks into the unit bucket AND the regression bucket, running
//     twice and muddying shard timing.
//   - DIRECTORY selector: `package.json` test:regression selects the whole
//     `src/__regression__` directory.
//
// Before spec-392, 8 files under __regression__ were bare `*.test.ts` (or
// carried a non-`.regression.` infix like `.static-scan.test.ts`) and so
// leaked. This guard pins the invariant: EVERY test file in this directory
// carries the `.regression.test.ts` suffix. A future contributor who drops a
// bare `foo.test.ts` here fails this test with the exact rename to make.
//
// Non-test helpers (e.g. prod-footer-baseline.ts) are intentionally NOT matched
// — they are imported by tests, not collected as tests, so they need no infix.

import { describe, it, expect } from "vitest";
import { tagAc } from "@memex-ai-ac/vitest";
import { readdirSync } from "node:fs";

const AC8 = "mindset-prod/memex-building-itself/specs/spec-392/acs/ac-8";

// Other test TIERS may legitimately appear here too; the rule is only that a
// FILE collected as a test under __regression__ must declare a tier infix, and
// the canonical tier for this directory is `.regression.`. We accept the small
// set of cross-tier infixes vitest also recognises so a deliberately-placed
// integration/api/security test isn't a false positive — but a BARE
// `*.test.ts` (no tier at all) is the leak this guard forbids.
const TIER_INFIXES = [
  ".regression.test.ts",
  ".integration.test.ts",
  ".api.test.ts",
  ".security.test.ts",
  ".perf.test.ts",
  ".smoke.test.ts",
];

function isTestFile(name: string): boolean {
  return name.endsWith(".test.ts");
}

function carriesTierInfix(name: string): boolean {
  return TIER_INFIXES.some((infix) => name.endsWith(infix));
}

describe("spec-392 ac-8: __regression__ filenames are tier-tagged (no bare *.test.ts leak)", () => {
  it("every test file under __regression__ carries a tier infix (canonically .regression.test.ts)", () => {
    tagAc(AC8);
    const entries = readdirSync(__dirname);
    const testFiles = entries.filter(isTestFile);

    // Sanity: the directory actually holds tests (so an empty read can't pass
    // the guard vacuously).
    expect(testFiles.length).toBeGreaterThan(20);

    const bare = testFiles.filter((n) => !carriesTierInfix(n));
    expect(
      bare,
      bare.length === 0
        ? ""
        : `These files under src/__regression__ are bare *.test.ts and leak into the ` +
            `test:unit bucket (which only excludes the tier infixes). Rename each to ` +
            `carry the .regression.test.ts infix (preserving any sub-label, e.g. ` +
            `foo.static-scan.regression.test.ts):\n` +
            bare.map((n) => `  ${n}  →  ${n.replace(/\.test\.ts$/, ".regression.test.ts")}`).join("\n"),
    ).toEqual([]);
  });

  it("the canonical regression infix is the dominant tier in this directory", () => {
    tagAc(AC8);
    // Defence against the infix list being relaxed into uselessness: the vast
    // majority of __regression__ files should be `.regression.test.ts`. If this
    // ever flips, someone has mis-homed a different tier's tests here.
    const testFiles = readdirSync(__dirname).filter(isTestFile);
    const regression = testFiles.filter((n) => n.endsWith(".regression.test.ts"));
    expect(regression.length).toBeGreaterThan(testFiles.length / 2);
  });
});
