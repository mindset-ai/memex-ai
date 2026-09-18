// spec-570 (dec-3) — the enforcing half of the package/CI coverage guard.
//
// `make check` runs in NO CI job (grepping all eight workflow files for `make `
// returns nothing) and `.husky/pre-push` skips it — the Makefile says so itself.
// So a guard living only in the offline lane gates nothing, which is this Spec's
// own defect committed a second time inside the change meant to fix it. This is
// the twin [per std-2]: the server suite is sharded across jobs branch
// protection actually requires, so this lane is what survives a bypassed hook.
//
// Both lanes call the SAME exported function. Two implementations could drift
// apart and the drift would be invisible — the whole shape this Spec is about.
//
// Every assertion below drives a TEMP FIXTURE rather than the live tree. A scan
// proven only against the real repository is indistinguishable from a scan that
// searches nothing: it passes either way. One case at the end does check the
// real workspace, because a guard that is only ever exercised on fixtures never
// proves the repository itself is in order.

import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tagAc } from "@memex-ai-ac/vitest";
import {
  COVERAGE,
  findCoverageGaps,
  testedPackages,
} from "../../../../scripts/ci/package-test-coverage.mjs";

const AC = (n: number) =>
  `mindset-prod/memex-building-itself/specs/spec-570/acs/ac-${n}`;

const REPO_ROOT = join(__dirname, "..", "..", "..", "..");

/** A throwaway workspace whose packages/* mirrors the declaration exactly. */
function fixture(extra: Array<{ name: string; test?: boolean }> = []) {
  const root = mkdtempSync(join(tmpdir(), "spec-570-coverage-"));
  const write = (name: string, hasTest: boolean) => {
    const dir = join(root, "packages", name.replace(/[@/]/g, "_"));
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ name, scripts: hasTest ? { test: "vitest run" } : {} }),
    );
  };
  for (const e of COVERAGE) write(e.pkg, true);
  for (const e of extra) write(e.name, e.test !== false);
  return root;
}

describe("spec-570: the package/CI coverage declaration is checked both ways (ac-11)", () => {
  it("a faithful workspace produces no findings — the guard's baseline", () => {
    tagAc(AC(11));
    const root = fixture();
    try {
      expect(findCoverageGaps(root)).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("a NEW package with a test script and no entry is refused", () => {
    tagAc(AC(11));
    const root = fixture([{ name: "@memex/brand-new" }]);
    try {
      const findings = findCoverageGaps(root);
      expect(
        findings.join("\n"),
        "a workspace package carrying tests and absent from COVERAGE is the " +
          "defect this guard exists for — it is how @memex/shared's 876 tests " +
          "ran nowhere for three and a half months",
      ).toContain("@memex/brand-new");
      expect(findings).toHaveLength(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("a STALE entry naming a package that no longer has tests is refused", () => {
    tagAc(AC(11));
    // The declaration's own package set, minus one: the entry now points at
    // nothing. A declaration checked in only one direction rots into fiction.
    const root = mkdtempSync(join(tmpdir(), "spec-570-coverage-stale-"));
    try {
      for (const e of COVERAGE.slice(1)) {
        const dir = join(root, "packages", e.pkg.replace(/[@/]/g, "_"));
        mkdirSync(dir, { recursive: true });
        writeFileSync(
          join(dir, "package.json"),
          JSON.stringify({ name: e.pkg, scripts: { test: "vitest run" } }),
        );
      }
      const findings = findCoverageGaps(root);
      expect(findings.join("\n")).toContain(COVERAGE[0].pkg);
      expect(findings.join("\n")).toContain("stale entry");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("the REAL workspace agrees with the declaration", () => {
    tagAc(AC(11));
    expect(findCoverageGaps(REPO_ROOT)).toEqual([]);
    expect(testedPackages(REPO_ROOT).length).toBe(COVERAGE.length);
  });
});

describe("spec-570: runs-somewhere and gates are distinct states (ac-13)", () => {
  it("db-schema is covered-but-not-gating, and says why", () => {
    tagAc(AC(13));
    const e = COVERAGE.find((c) => c.pkg === "@mindset-ai/db-schema");
    expect(e, "@mindset-ai/db-schema must be declared").toBeDefined();
    // It RUNS…
    expect(e!.job).not.toBeNull();
    // …and deliberately does NOT gate. A single boolean would have to call this
    // either a pass or a violation, and both would be wrong.
    expect(e!.gates).toBeNull();
    expect(e!.why ?? "").not.toBe("");
    expect(e!.why!.toLowerCase()).toContain("path-filtered");
  });

  it("the two packages this Spec wired DO gate, under their job keys", () => {
    tagAc(AC(13));
    for (const pkg of ["@memex/shared", "@memex/extractor"]) {
      const e = COVERAGE.find((c) => c.pkg === pkg)!;
      expect(e.gates, `${pkg} must gate`).not.toBeNull();
      // The registered context IS the job key — a required context pinned to a
      // name that later changes silently stops gating (the spec-390 lesson).
      expect(e.gates).toBe(e.job);
    }
  });

  it("an entry claiming to gate while nothing runs it is REFUSED by the guard", () => {
    tagAc(AC(13));
    // Driven through findCoverageGaps with an injected malformed declaration —
    // the rule cannot be proven against a declaration that is already correct,
    // and a test that only re-states the condition in its own words would pass
    // even if the guard stopped checking it.
    const root = mkdtempSync(join(tmpdir(), "spec-570-coverage-orphan-"));
    try {
      const dir = join(root, "packages", "orphan");
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, "package.json"),
        JSON.stringify({ name: "@x/orphan", scripts: { test: "vitest run" } }),
      );
      const findings = findCoverageGaps(root, [
        {
          pkg: "@x/orphan",
          localSuite: "pnpm --filter @x/orphan test",
          workflow: null,
          job: null,
          gates: "orphan",
          why: "deliberately outside CI",
        },
      ]);
      expect(
        findings.join("\n"),
        "a context no job produces would be registered, never report, and wedge " +
          "every PR at 'Expected — waiting for status' with no admin bypass",
      ).toContain("never reports");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
    // And the shipped declaration contains no such entry.
    expect(COVERAGE.filter((c) => c.job === null && c.gates !== null)).toEqual([]);
  });

  it("every entry that does not run, or does not gate, carries a reason", () => {
    tagAc(AC(13));
    for (const e of COVERAGE) {
      if (e.job === null || e.gates === null) {
        expect(
          (e.why ?? "").trim(),
          `${e.pkg} opts out of running or gating and must say why — silence is ` +
            `how two packages went unobserved for three and a half months`,
        ).not.toBe("");
      }
    }
  });
});

describe("spec-570: the guard reaches a lane CI runs (ac-14)", () => {
  it("`make check` invokes the offline half — asserted against the Makefile", () => {
    tagAc(AC(14));
    // The offline lane and this suite call the SAME exported function, so there
    // is no second implementation to drift. What still has to be pinned is that
    // the offline lane is actually WIRED: a `check-` target nothing depends on
    // is a guard that guards nothing, which is this Spec's entire subject.
    const makefile = readFileSync(join(REPO_ROOT, "Makefile"), "utf8");
    const checkTarget = makefile
      .split("\n")
      .find((l) => l.startsWith("check:"));
    expect(checkTarget, "the Makefile has no `check:` target").toBeDefined();
    expect(
      checkTarget!,
      "check-package-coverage must be a prerequisite of `make check`, or the " +
        "offline half of the twin runs only when someone remembers it",
    ).toContain("check-package-coverage");
    expect(makefile).toContain("node scripts/ci/package-test-coverage.mjs");
  });
});
