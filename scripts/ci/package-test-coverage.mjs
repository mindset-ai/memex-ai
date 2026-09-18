// Every workspace package that carries a `test` script is accounted for — and
// "runs somewhere" is not the same claim as "gates" (spec-570 dec-3, ac-11/ac-13).
//
//   node scripts/ci/package-test-coverage.mjs    # offline lane (`make check`)
//
// Why this exists: `@memex/shared` (876 tests) and `@memex/extractor` (62) ran
// in NO CI job and no git hook for three and a half months. The b-67 gate inside
// shared's suite had never passed in the repository's history — the bound and two
// of its violations shipped in the initial commit — and nothing anywhere said so.
// Wiring those two packages fixes today. It does nothing about the next package,
// because NOTHING asserted that a workspace package carrying tests is reachable
// from CI. That absence was the root cause; the two orphans were its symptoms.
//
// dec-3 chose a DECLARATION over a grep of `.github/workflows/*.yml`. Grepping is
// wrong in both directions: it misses `@mindset-ai/db-schema` (covered, but in
// db-schema-drift.yml rather than test.yml) and it would clear that package on a
// job which is path-filtered, does not run on most PRs, and can never be a
// required context. It is also structurally blind to scripts/ci/affected-tests.mjs.
//
// TWIN-GUARD [per std-2]: `findCoverageGaps` is the whole check, exported so the
// vitest regression suite asserts the same thing. `.husky/pre-push` runs lint +
// typecheck + unit tests and NOT `make check`, so a guard living only here would
// not see a push; one living only in vitest would not run in the offline lane.
// Two lanes, one function — never two implementations that can disagree.

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/** Where the workspace's packages live. `pnpm-workspace.yaml` is `packages/*`. */
export const PACKAGES_DIR = "packages";

// The declaration. One entry per workspace package carrying a `test` script.
//
//   pkg        the package.json `name`
//   localSuite the command a FULL local run must execute for this package.
//              `scripts/ci/affected-tests.mjs` derives its FULL_MATRIX from these
//              rather than restating them, so adding a package is one edit here
//              and not three scattered ones.
//   workflow   the workflow file whose job runs it in CI, or null
//   job        that workflow's job key, or null
//   gates      the branch-protection required-status context this package's
//              failure turns red, or null when it runs without gating
//   why        REQUIRED whenever `job` or `gates` is null. A package outside CI,
//              or inside CI without gating, is a decision somebody made; the
//              absence of any way to say so is exactly how two packages went
//              three and a half months unobserved.
export const COVERAGE = [
  {
    pkg: "@memex/server",
    localSuite: "make test-server",
    workflow: "test.yml",
    job: "server",
    // Sharded across three jobs; branch protection requires the stable
    // AGGREGATOR name, not the shard job. A required context pinned to a name
    // that later changes silently stops gating (the spec-390 lesson).
    gates: "server-result",
  },
  {
    pkg: "@memex/ui",
    // CI runs `test:coverage` (test.yml) because it also enforces the coverage
    // gate; this field is the LOCAL full-run command, which is the plain suite.
    localSuite: "make test-ui",
    workflow: "test.yml",
    job: "ui",
    gates: "ui",
  },
  {
    pkg: "memex-ai",
    localSuite: "pnpm --filter memex-ai test",
    workflow: "test.yml",
    job: "cli",
    gates: "cli",
  },
  {
    pkg: "@memex-ai-ac/vitest",
    localSuite: "pnpm --filter @memex-ai-ac/vitest test",
    workflow: "test.yml",
    job: "ac-emit",
    gates: "ac-emit",
  },
  {
    pkg: "@memex/shared",
    localSuite: "pnpm --filter @memex/shared test",
    workflow: "test.yml",
    job: "shared",
    gates: "shared",
  },
  {
    pkg: "@memex/extractor",
    localSuite: "pnpm --filter @memex/extractor test",
    workflow: "test.yml",
    job: "extractor",
    gates: "extractor",
  },
  {
    pkg: "@mindset-ai/db-schema",
    localSuite: "pnpm --filter @mindset-ai/db-schema test",
    workflow: "db-schema-drift.yml",
    job: "drift",
    // RUNS, and deliberately does NOT gate. This is the case that forces the two
    // states apart, and the reason must survive the next reader who notices the
    // asymmetry and "fixes" it:
    gates: null,
    why:
      "db-schema-drift.yml is path-filtered, so its job does not report on the " +
      "PRs it skips. A required context that never reports leaves those PRs at " +
      '"Expected — waiting for status" forever, and enforce_admins is on, so ' +
      "nobody — not even an admin — can merge past it. This package must never " +
      "be added to branch protection while its job stays path-filtered.",
  },
];

/** Packages under `packages/*` that declare a `test` script, by package name. */
export function testedPackages(repoRoot) {
  const dir = join(repoRoot, PACKAGES_DIR);
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const found = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    let pkg;
    try {
      pkg = JSON.parse(readFileSync(join(dir, e.name, "package.json"), "utf8"));
    } catch {
      continue; // not a package — nothing to account for
    }
    if (pkg?.scripts?.test && pkg.name) found.push(pkg.name);
  }
  return found.sort();
}

/** Every way the declaration and the workspace can disagree, as plain sentences.
 *  Pure: takes a root, reads files, returns findings. No process exit, no log.
 *  `coverage` defaults to the shipped declaration and is injectable so the twin
 *  can drive a MALFORMED one — the rules below cannot be proven against a
 *  declaration that is already correct. */
export function findCoverageGaps(repoRoot, coverage = COVERAGE) {
  const findings = [];
  const declared = new Set(coverage.map((e) => e.pkg));
  const actual = new Set(testedPackages(repoRoot));

  // 1. A package with tests and no entry. THE defect this guard exists for.
  for (const pkg of [...actual].sort()) {
    if (!declared.has(pkg)) {
      findings.push(
        `${pkg} has a \`test\` script and no entry in COVERAGE — its suite may run nowhere`,
      );
    }
  }

  // 2. An entry for a package that is gone, or has lost its test script. A
  //    declaration nobody checks in this direction rots into fiction.
  for (const pkg of [...declared].sort()) {
    if (!actual.has(pkg)) {
      findings.push(
        `COVERAGE declares ${pkg}, which is not a workspace package with a \`test\` script — stale entry`,
      );
    }
  }

  for (const e of coverage) {
    const why = typeof e.why === "string" ? e.why.trim() : "";

    // 3. Silence is not a passing state. Not running, or running without
    //    gating, is a decision — it has to be written down as one.
    if ((e.job === null || e.gates === null) && why === "") {
      findings.push(
        `${e.pkg} declares ${e.job === null ? "no CI job" : "no gating context"} and gives no \`why\``,
      );
    }

    // 4. The dual of ac-13: a package that runs nowhere cannot gate anything.
    //    Claiming otherwise re-creates the permanent-block failure mode — a
    //    required context that never reports, with no admin bypass.
    if (e.job === null && e.gates !== null) {
      findings.push(
        `${e.pkg} declares gates=${JSON.stringify(e.gates)} but no CI job runs it — a context that never reports blocks every PR forever`,
      );
    }

    if (!e.localSuite || !e.localSuite.trim()) {
      findings.push(`${e.pkg} declares no \`localSuite\` — a full local run would skip it`);
    }
  }

  return findings;
}

function main(repoRoot) {
  const findings = findCoverageGaps(repoRoot);
  if (findings.length === 0) {
    process.stdout.write(
      `✓ all ${COVERAGE.length} workspace packages with tests are accounted for ` +
        `(spec-570 ac-11, ac-13)\n`,
    );
    return 0;
  }
  process.stderr.write(
    "✗ the package/CI coverage declaration and the workspace disagree.\n\n" +
      findings.map((f) => `    ${f}\n`).join("") +
      "\n  Every workspace package carrying a `test` script needs an entry in\n" +
      "  COVERAGE, saying where its suite runs and which required status context\n" +
      "  it turns red. Not running, or running without gating, is allowed — and\n" +
      "  must carry a `why`. Silence is what let @memex/shared's 876 tests go\n" +
      "  three and a half months without a single automated run.\n" +
      "  Check: scripts/ci/package-test-coverage.mjs\n",
  );
  return 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main(process.argv[2] ?? process.cwd()));
}
