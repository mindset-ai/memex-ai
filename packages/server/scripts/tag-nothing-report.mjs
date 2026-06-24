// "Tests that tag nothing" report (spec-391 dec-6, ac-12).
//
// Walks the test corpus and prints the test files that have ≥1 test case but
// tag ZERO acceptance criteria, ranked by case count (highest-value gaps first).
// A REPORT, not a CI gate: it informs the incremental tagging effort, it never
// fails the build. The scan logic mirrors src/services/tag-nothing-scan.ts (the
// unit-tested core); this script is the filesystem I/O wrapper.
//
// Usage: node scripts/tag-nothing-report.mjs [rootDir]
//   rootDir defaults to the repo root (two levels up from packages/server).

import { readFileSync, readdirSync, statSync } from "node:fs";
import { resolve, dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = process.argv[2]
  ? resolve(process.argv[2])
  : resolve(__dirname, "../../..");

const CASE_OPENER = /\b(?:it|test)(?:\.(?:only|skip|each|concurrent|fails|todo))?\s*[(`]/g;
const AC_TAG = /\b(?:tagAc|emitAcEvents|installAcEmission)\s*\(/;
const TEST_FILE = /\.(?:test|spec)\.[cm]?tsx?$/;
const SKIP_DIRS = new Set(["node_modules", "dist", ".git", "coverage", ".turbo", "build"]);

function walk(dir, out) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    if (SKIP_DIRS.has(name)) continue;
    const full = join(dir, name);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) walk(full, out);
    else if (TEST_FILE.test(name)) out.push(full);
  }
  return out;
}

const files = walk(repoRoot, []);
const flagged = [];
for (const file of files) {
  let src;
  try {
    src = readFileSync(file, "utf8");
  } catch {
    continue;
  }
  const caseCount = (src.match(CASE_OPENER) ?? []).length;
  const tagsAcs = AC_TAG.test(src);
  if (caseCount > 0 && !tagsAcs) {
    flagged.push({ file: relative(repoRoot, file), caseCount });
  }
}

flagged.sort((a, b) => b.caseCount - a.caseCount || a.file.localeCompare(b.file));

const totalCases = flagged.reduce((n, f) => n + f.caseCount, 0);
console.log(`# Tests that tag nothing — ${flagged.length} files, ${totalCases} untagged test cases`);
console.log(`# (files with ≥1 test case but no tagAc/emitAcEvents/installAcEmission call)`);
console.log(`# Ranked by case count — tag the top of this list first.\n`);
for (const f of flagged) {
  console.log(`${String(f.caseCount).padStart(4)}  ${f.file}`);
}
// Always exit 0 — this is a report, not a gate (dec-6).
process.exit(0);
