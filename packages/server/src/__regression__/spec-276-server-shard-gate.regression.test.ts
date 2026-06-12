// spec-276 — the server suite is SHARDED across CI runners to cut merge-gate
// wall-clock, WITHOUT weakening the t-17 coverage gate. These are static
// assertions on `.github/workflows/test.yml` (the same shape as the spec-172
// e2e-pipeline guards and the spec-168 cicd-deploy-config guards). They pin the
// load-bearing structure so a future edit can't silently:
//
//   1. collapse the shard matrix (ac-6) — losing the parallelism;
//   2. drop the collect-only coverage flags on a shard (ac-7) — which would make
//      every shard exit 1 on its partial coverage (verified: vitest 4.1.1's blob
//      reporter does NOT defer threshold checks), OR drop blob/coverage entirely;
//   3. stop enforcing the threshold on the MERGED coverage (ac-8) — turning the
//      gate into a no-op;
//   4. make the aggregator fail-OPEN (ac-9) — letting a cancelled/failed shard or
//      a missing blob pass as green on partial coverage.
//
// What these CANNOT assert (verified only by the live CI run, self-reported from
// the server-result job per the e2e-result precedent): the ~3min wall-clock
// (ac-1), the merged test count (ac-2), and that the threshold actually fires on
// merged coverage (ac-3). A green structural test means "the workflow invokes the
// right commands", NOT "the coverage math is correct".
//
// Branch protection (requiring `server-result` on develop + main, dropping the
// old `server` check) is a repo-settings surface GitHub doesn't let repo contents
// assert — that is ac-5, verified manually at flip time (t-4).

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { tagAc } from "@memex-ai-ac/vitest";

const SPEC = "mindset-prod/memex-building-itself/specs/spec-276";
const REPO_ROOT = join(__dirname, "..", "..", "..", "..");
const TEST_YML = readFileSync(
  join(REPO_ROOT, ".github", "workflows", "test.yml"),
  "utf-8",
);

// Extract one top-level job block: from `\n  <name>:` to the next 2-space-indented
// `\n  <other>:` key (or EOF). Mirrors the helper in spec-172-e2e-pipeline-gate.
function jobBlock(name: string): string {
  const start = TEST_YML.search(new RegExp(`^  ${name}:\\s*$`, "m"));
  expect(start, `job "${name}" exists in test.yml`).toBeGreaterThan(-1);
  const rest = TEST_YML.slice(start + 1);
  const next = rest.search(/^  [A-Za-z0-9_-]+:\s*$/m);
  return next === -1 ? TEST_YML.slice(start) : TEST_YML.slice(start, start + 1 + next);
}

describe("spec-276 — the server suite is sharded but the coverage gate is intact", () => {
  it("ac-6: the server job is a 3-way shard matrix, each leg with its own Postgres", () => {
    tagAc(`${SPEC}/acs/ac-6`);
    const server = jobBlock("server");
    // 3-way matrix on `shard`.
    expect(server, "server job declares a matrix").toMatch(/^\s*matrix:\s*$/m);
    expect(server, "matrix shards over [1, 2, 3]").toMatch(/shard:\s*\[\s*1\s*,\s*2\s*,\s*3\s*\]/);
    // Each leg runs only its 1/3 slice.
    expect(server).toMatch(/--shard=\$\{\{\s*matrix\.shard\s*\}\}\/3/);
    // Own Postgres side-car (pgvector pg16), so the per-worker DB clones don't collide.
    expect(server, "server shard has its own pgvector pg16 service").toMatch(
      /services:[\s\S]*postgres:[\s\S]*pgvector\/pgvector:pg16/,
    );
  });

  it("ac-7: each shard collects coverage into a blob WITHOUT enforcing thresholds, and uploads it", () => {
    tagAc(`${SPEC}/acs/ac-7`);
    const server = jobBlock("server");
    expect(server, "shard runs under coverage").toMatch(/--coverage\b/);
    expect(server, "shard emits a blob report").toMatch(/--reporter=blob\b/);
    // Collect-only: all four metric thresholds forced to 0 so a shard does NOT
    // gate on its partial coverage. (Drop any one and that shard reds out.)
    for (const metric of ["lines", "functions", "branches", "statements"]) {
      expect(
        server,
        `shard disables the ${metric} threshold (collect-only)`,
      ).toMatch(new RegExp(`--coverage\\.thresholds\\.${metric}=0\\b`));
    }
    // The blob is uploaded as an artifact for the merge job to pick up.
    expect(server, "shard uploads its coverage blob").toMatch(/upload-artifact/);
    expect(server).toMatch(/\.vitest-reports/);
    // MUST include hidden files: vitest writes the blob into `.vitest-reports/`
    // (a dot-dir) and upload-artifact@v4 excludes hidden files by default — without
    // this the upload finds nothing and server-result fails closed on 0 blobs.
    // (Caught by PR #169's first CI run; this assertion pins the fix.)
    expect(server, "blob upload includes hidden files").toMatch(/include-hidden-files:\s*true/);
  });

  it("ac-8: server-result merges the blobs and enforces the threshold on MERGED coverage", () => {
    tagAc(`${SPEC}/acs/ac-8`);
    const agg = jobBlock("server-result");
    expect(agg, "merges the shard blobs under coverage").toMatch(
      /vitest\s+--merge-reports\s+--coverage|--merge-reports[\s\S]*--coverage/,
    );
    // The merge step must NOT carry a blob reporter — vitest hard-errors
    // ("Cannot merge reports when --reporter=blob is used").
    const mergeLine = agg
      .split("\n")
      .find((l) => l.includes("--merge-reports")) ?? "";
    expect(mergeLine, "merge step does not pass --reporter=blob").not.toMatch(/--reporter=blob/);
  });

  it("ac-9: server-result fails CLOSED on a cancelled/failed shard or a missing blob", () => {
    tagAc(`${SPEC}/acs/ac-9`);
    const agg = jobBlock("server-result");
    expect(agg, "depends on the server matrix").toMatch(/^    needs:\s*\[?\s*server\s*\]?\s*$/m);
    // `if: always()` is what makes a SKIPPED/CANCELLED server read as RED here
    // rather than a green-ish skip.
    expect(agg).toMatch(/^    if:\s*always\(\)\s*$/m);
    expect(agg, "guards on the matrix result").toMatch(/needs\.server\.result/);
    expect(agg).toMatch(/!=\s*['"]success['"]/);
    expect(agg).toMatch(/exit 1/);
    // Fail on a missing blob — a partial blob set must not merge to a green gate.
    expect(agg, "asserts the expected blob count (fail on missing)").toMatch(/-ne 3|!= 3|-lt 3/);
  });
});
