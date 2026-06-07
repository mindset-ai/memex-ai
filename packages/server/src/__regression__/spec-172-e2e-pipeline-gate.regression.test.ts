// spec-172 ac-4 — the e2e Playwright suite is the PR-gate tier and must never be
// quietly skipped in the GitHub pipeline again. That is exactly how the suite
// rotted pre-spec-172: an `if: schedule || workflow_dispatch` gate parked it out
// of the per-PR path, nothing noticed, and 32/33 tests decayed against a moved
// schema. These are static assertions on `.github/workflows/test.yml` (the same
// shape as the spec-168 cicd-deploy-config guards) — they fail the server suite
// loudly if any skip vector is reintroduced:
//
//   1. the `e2e` job carries NO job-level `if:` (it runs whenever the workflow runs);
//   2. the workflow triggers on push + pull_request for develop AND main, with no
//      `paths:` / `paths-ignore:` filter that could skip it for "unrelated" changes;
//   3. the `e2e` job actually runs the Playwright suite;
//   4. the `e2e-result` aggregator exists (the stable branch-protection check name),
//      depends on `e2e`, runs `if: always()`, and fails on anything but success —
//      so SKIPPED shards read as a red check, never a silent pass.
//
// Branch protection itself (requiring `e2e-result` on develop + main) is a repo
// settings surface GitHub doesn't let the repo contents assert — that half of ac-4
// is verified manually at flip time [per std-28 cl-3].

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { tagAc } from "@memex-ai-ac/vitest";

const SPEC = "mindset-prod/memex-building-itself/specs/spec-172";
const REPO_ROOT = join(__dirname, "..", "..", "..", "..");
const TEST_YML = readFileSync(
  join(REPO_ROOT, ".github", "workflows", "test.yml"),
  "utf-8",
);

// Extract one top-level job block: from `\n  <name>:` to the next 2-space-indented
// `\n  <other>:` key (or EOF). Comments between jobs belong to the FOLLOWING job and
// don't matter for these assertions.
function jobBlock(name: string): string {
  const start = TEST_YML.search(new RegExp(`^  ${name}:\\s*$`, "m"));
  expect(start, `job "${name}" exists in test.yml`).toBeGreaterThan(-1);
  const rest = TEST_YML.slice(start + 1);
  const next = rest.search(/^  [A-Za-z0-9_-]+:\s*$/m);
  return next === -1 ? TEST_YML.slice(start) : TEST_YML.slice(start, start + 1 + next);
}

describe("spec-172 ac-4 — the e2e job cannot be quietly skipped", () => {
  it("the e2e job has no job-level `if:` gate", () => {
    tagAc(`${SPEC}/acs/ac-4`);
    const e2e = jobBlock("e2e");
    // Job-level keys sit at exactly 4 spaces; step-level `if:` (failure(),
    // cache-hit) sits deeper and is legitimate.
    expect(e2e).not.toMatch(/^    if:/m);
  });

  it("the workflow triggers on push + pull_request for develop and main, unfiltered", () => {
    tagAc(`${SPEC}/acs/ac-4`);
    // `on:` block runs to the first top-level key after it (jobs:/env:/...).
    const onStart = TEST_YML.search(/^on:\s*$/m);
    expect(onStart, "`on:` block exists").toBeGreaterThan(-1);
    const afterOn = TEST_YML.slice(onStart + "on:".length);
    const onEnd = afterOn.search(/^[a-zA-Z][a-zA-Z0-9_-]*:/m);
    const onBlock = onEnd === -1 ? afterOn : afterOn.slice(0, onEnd);

    expect(onBlock).toMatch(/^  push:\s*$/m);
    expect(onBlock).toMatch(/^  pull_request:\s*$/m);
    // Both triggers list both protected branches.
    const branchLines = onBlock.match(/branches:\s*\[([^\]]*)\]/g) ?? [];
    expect(branchLines.length).toBeGreaterThanOrEqual(2);
    for (const line of branchLines.slice(0, 2)) {
      expect(line).toContain("main");
      expect(line).toContain("develop");
    }
    // No path filtering — a "docs-only" carve-out is a skip vector.
    expect(onBlock).not.toMatch(/paths(-ignore)?:/);
  });

  it("the e2e job runs the Playwright suite", () => {
    tagAc(`${SPEC}/acs/ac-4`);
    expect(jobBlock("e2e")).toMatch(/test:e2e/);
  });

  it("e2e-result aggregates the shards and fails on anything but success", () => {
    tagAc(`${SPEC}/acs/ac-4`);
    const agg = jobBlock("e2e-result");
    expect(agg).toMatch(/^    needs:\s*e2e\s*$/m);
    // `if: always()` is what makes a SKIPPED e2e read as a RED e2e-result rather
    // than a skipped (and therefore green-ish) one.
    expect(agg).toMatch(/^    if:\s*always\(\)\s*$/m);
    expect(agg).toMatch(/needs\.e2e\.result/);
    expect(agg).toMatch(/!=\s*"success"/);
    expect(agg).toMatch(/exit 1/);
  });
});
