// "Tests that tag nothing" scan (spec-391 dec-6, ac-12).
//
// ~213 test files (27%) run green but tag ZERO acceptance criteria — real
// verification the AI-first deploy signal can't see. This module is the pure,
// testable core of the report: given a test file's source, count its test cases
// and whether it tags any AC. The thin script (scripts/tag-nothing-report.mjs)
// walks the corpus, calls this per file, and prints the ranked report.
//
// REPORT, not a gate (dec-6): it surfaces the backlog ranked by case count so
// the high-value files get tagged incrementally; it never fails CI. A blanket
// gate at 213 files would block every PR until the whole backlog is cleared.

/** Per-file scan result. */
export interface TagNothingScanResult {
  /** Number of test cases (it(...) / test(...) declarations) in the file. */
  caseCount: number;
  /** True when the file calls tagAc(...) or emitAcEvents(...)/installAcEmission(...). */
  tagsAcs: boolean;
}

// it( / it.only( / it.each( / test( / test.only( ... — the case openers. We count
// declarations, not invocations of helpers; describe(...) is not a case.
const CASE_OPENER = /\b(?:it|test)(?:\.(?:only|skip|each|concurrent|fails|todo))?\s*[(`]/g;

// Any of the AC-tagging entry points used across the suites: tagAc (vitest),
// emitAcEvents (e2e), installAcEmission (the spec-391 e2e fixture).
const AC_TAG = /\b(?:tagAc|emitAcEvents|installAcEmission)\s*\(/;

/**
 * Scan one test file's source. Comment/string nuance is intentionally NOT
 * handled — this is a coarse corpus report, and a stray match only makes a file
 * look "covered" or "has cases", both of which a human reviewer can sanity-check
 * from the ranked list. Cheap and good-enough beats a parser here.
 */
export function scanTestSource(source: string): TagNothingScanResult {
  const caseCount = (source.match(CASE_OPENER) ?? []).length;
  const tagsAcs = AC_TAG.test(source);
  return { caseCount, tagsAcs };
}

export interface TagNothingFileReport {
  file: string;
  caseCount: number;
}

/**
 * Given per-file scan results, return the files that have ≥1 test case but tag
 * NO ACs, ranked by case count descending (the highest-value gaps first).
 */
export function rankTagNothingFiles(
  scanned: { file: string; result: TagNothingScanResult }[],
): TagNothingFileReport[] {
  return scanned
    .filter((s) => s.result.caseCount > 0 && !s.result.tagsAcs)
    .map((s) => ({ file: s.file, caseCount: s.result.caseCount }))
    .sort((a, b) => b.caseCount - a.caseCount || a.file.localeCompare(b.file));
}
