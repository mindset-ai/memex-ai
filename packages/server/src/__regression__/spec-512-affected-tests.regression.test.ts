// spec-512 ac-4 — the diff→affected-tests mapper must never return silently empty.
//
// The whole value of a "run just these" tool is that an agent trusts it. That
// makes its failure mode uniquely dangerous: a mapper that shrugs at a path it
// does not recognise and prints an empty list is read as "nothing to run, you're
// safe" — a confident wrong answer, which is the exact category this Spec exists
// to delete. So an unrecognised path must widen to the full matrix, never narrow
// to nothing, and the tool must always say CI still runs everything.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { tagAc } from "@memex-ai-ac/vitest";
import { planFor, RULES } from "../../../../scripts/ci/affected-tests.mjs";

const REPO_ROOT = join(__dirname, "..", "..", "..", "..");
const SOURCE = readFileSync(
  join(REPO_ROOT, "scripts", "ci", "affected-tests.mjs"),
  "utf8",
);

describe("spec-512: the affected-tests mapper fails safe, never silent", () => {
  it("an UNRECOGNISED path widens to the full matrix (ac-4)", () => {
    tagAc("mindset-prod/memex-building-itself/specs/spec-512/acs/ac-4");

    for (const weird of [
      "some/unknown/path.xyz",
      "totally-new-top-level-dir/thing.rs",
      "packages/brand-new-package/src/index.ts",
      ".hidden-config",
    ]) {
      const plan = planFor([weird]);
      expect(
        plan.full,
        `"${weird}" matches no rule, so the mapper must widen to the FULL matrix. ` +
          `Narrowing an incomplete map tells an agent "nothing to run" and it will ` +
          `believe that.\n\nCheck: scripts/ci/affected-tests.mjs`,
      ).toBe(true);
      expect(plan.commands.length).toBeGreaterThan(0);
      expect(plan.unmatched).toContain(weird);
    }
  });

  it("an EMPTY changed-file list widens too (ac-4)", () => {
    tagAc("mindset-prod/memex-building-itself/specs/spec-512/acs/ac-4");
    // "I found no changes" and "there are no changes" are indistinguishable from
    // the outside, and the dangerous reading of both is "skip the tests".
    for (const input of [[], null, undefined]) {
      const plan = planFor(input as never);
      expect(plan.full).toBe(true);
      expect(plan.commands.length).toBeGreaterThan(0);
    }
  });

  it("one unknown path poisons an otherwise-narrowable set (ac-4)", () => {
    tagAc("mindset-prod/memex-building-itself/specs/spec-512/acs/ac-4");
    // The subtle case: recognised files would narrow happily, and it is tempting
    // to return their union and quietly drop the stranger.
    const plan = planFor(["packages/ui/src/App.tsx", "mystery/file.bin"]);
    expect(
      plan.full,
      "A recognised path alongside an unrecognised one must still widen — " +
        "dropping the stranger silently under-runs the suite.",
    ).toBe(true);
    expect(plan.unmatched).toEqual(["mystery/file.bin"]);
  });

  it("broad-impact paths widen with a stated reason (ac-4)", () => {
    tagAc("mindset-prod/memex-building-itself/specs/spec-512/acs/ac-4");
    for (const broad of [
      "pnpm-lock.yaml",
      "packages/shared/src/scaffold-data.ts",
      "packages/server/src/db/schema.ts",
      ".github/workflows/test.yml",
      "Makefile",
    ]) {
      const plan = planFor([broad]);
      expect(plan.full, `"${broad}" must widen to the full matrix`).toBe(true);
      expect(plan.reason).toBeTruthy();
    }
  });

  it("genuinely narrow changes DO narrow — the tool is still useful (ac-4)", () => {
    tagAc("mindset-prod/memex-building-itself/specs/spec-512/acs/ac-4");
    // The counterweight: a mapper that always returns "full" would pass every
    // assertion above while being worthless.
    const plan = planFor(["packages/ui/src/components/Foo.tsx"]);
    expect(plan.full).toBe(false);
    expect(plan.commands).toEqual(["make test-ui"]);

    const server = planFor(["packages/server/src/routes/docs.ts"]);
    expect(server.full).toBe(false);
    expect(server.commands).toContain("make test-api");
  });

  it("every run states that CI still runs the full matrix (ac-4)", () => {
    tagAc("mindset-prod/memex-building-itself/specs/spec-512/acs/ac-4");
    // Printed unconditionally in emit(), including the docs-only case where the
    // command list is legitimately empty — that is exactly when a reader is most
    // likely to mistake it for a merge guarantee.
    expect(
      SOURCE,
      "The human-readable output must always say CI runs the full matrix.",
    ).toMatch(/CI still runs the full matrix/);
    expect(SOURCE).toMatch(/advisory/i);
  });

  it("the rule table is real and ordered first-match-wins (ac-4)", () => {
    tagAc("mindset-prod/memex-building-itself/specs/spec-512/acs/ac-4");
    // Denominator: a truncated rule table would make everything widen and the
    // tool would look "safe" while being useless.
    expect(
      RULES.length,
      `Only ${RULES.length} mapping rules — the table has probably been truncated, ` +
        `which would make every change widen to the full matrix.`,
    ).toBeGreaterThan(15);
    for (const r of RULES) {
      expect(r.test).toBeInstanceOf(RegExp);
      expect(r.why, "every rule states WHY, so its output can be audited").toBeTruthy();
      expect(r.full === true || Array.isArray(r.cmds)).toBe(true);
    }
  });
});
