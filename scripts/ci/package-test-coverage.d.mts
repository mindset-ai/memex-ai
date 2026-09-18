// Types for package-test-coverage.mjs (spec-570 dec-3). See workspace-alloc.d.mts
// for why the implementation is an untyped `.mjs` and this declaration exists.
//
// `findCoverageGaps` and `testedPackages` are pure and take a repo root, so the
// vitest twin-guard can drive them against a temp fixture — a scan proven only
// against the real tree is indistinguishable from a scan that searches nothing.

/** One workspace package carrying a `test` script, and where that suite runs. */
export interface CoverageEntry {
  /** The package.json `name`. */
  readonly pkg: string;
  /** The command a FULL local run must execute for this package.
   *  `affected-tests.mjs` derives its FULL_MATRIX from these rather than
   *  restating them. */
  readonly localSuite: string;
  /** The workflow file whose job runs it in CI, or null. */
  readonly workflow: string | null;
  /** That workflow's job key, or null when no CI job runs this package. */
  readonly job: string | null;
  /** The branch-protection required-status context this package's failure turns
   *  red, or null when it runs without gating. NOT the same claim as `job`:
   *  `@mindset-ai/db-schema` runs in a path-filtered job and must never gate. */
  readonly gates: string | null;
  /** Required whenever `job` or `gates` is null — the decision, written down. */
  readonly why?: string;
}

export const PACKAGES_DIR: string;

/** The declaration: one entry per workspace package with a `test` script. */
export const COVERAGE: readonly CoverageEntry[];

/** Packages under `packages/*` declaring a `test` script, by name, sorted.
 *  Reads the workspace itself — this is the reality the declaration is checked
 *  against, in both directions. */
export function testedPackages(repoRoot: string): string[];

/** Every way the declaration and the workspace disagree, as plain sentences.
 *  Empty means they agree. Covers: a tested package with no entry; an entry
 *  whose package is gone or has lost its test script; a null `job`/`gates` with
 *  no stated reason; and an entry claiming to gate while nothing runs it —
 *  which would register a context that never reports and wedge every PR. */
export function findCoverageGaps(
  repoRoot: string,
  coverage?: readonly CoverageEntry[],
): string[];
