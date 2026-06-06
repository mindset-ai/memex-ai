// spec-172 t-8 / ac-12 — the PR-gate e2e Standard (std-28) MUST be indexed in
// the repo-root CLAUDE.md standards table.
//
// dec-4 made the per-change e2e-journey discipline a standing Standard (std-28),
// the merge-side sibling of std-17's post-deploy smoke rule. A Standard that
// nobody can find from the codebase pointer is half-authored: CLAUDE.md's
// standards index is how an agent orienting in this repo discovers which rules
// bind it. This test pins that the std-28 row exists and actually describes the
// e2e rule, so a careless CLAUDE.md edit that drops it fails CI.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { tagAc } from "@memex-ai-ac/vitest";

// packages/server/src/__regression__/<this file> → repo root
const REPO_ROOT = join(__dirname, "..", "..", "..", "..");
const CLAUDE_MD = join(REPO_ROOT, "CLAUDE.md");

describe("regression: spec-172 PR-gate e2e Standard CLAUDE.md index row (ac-12)", () => {
  const claudeMd = readFileSync(CLAUDE_MD, "utf8");

  // Pull the standards-index table rows: `| std-N | … |`
  const rows = claudeMd
    .split("\n")
    .filter((line) => /^\|\s*std-\d+\s*\|/.test(line));

  it("CLAUDE.md has a standards index with std-N rows", () => {
    // Guard against the regex / table shape silently breaking — without this,
    // a zero-row match would let the std-28 assertion below vacuously pass.
    expect(rows.length).toBeGreaterThan(0);
  });

  it("a std-28 row exists in the standards index and describes the PR-gate e2e rule", () => {
    // ac-12: the CLAUDE.md standards index row is added for the new Standard.
    tagAc("mindset-prod/memex-building-itself/specs/spec-172/acs/ac-12");

    const std28 = rows.find((line) => /^\|\s*std-28\s*\|/.test(line));
    expect(std28, "CLAUDE.md standards index is missing a std-28 row").toBeDefined();

    // The row must actually describe the e2e journey discipline, not be a
    // placeholder — assert the load-bearing terms of dec-4 / ac-11 / ac-12.
    expect(std28!).toMatch(/e2e/i);
    expect(std28!).toMatch(/journey|playwright/i);
    expect(std28!).toMatch(/packages\/ui\/e2e/);
  });
});
