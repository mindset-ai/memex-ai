// spec-390 (spec-388 dec-1, workstream A): the server coverage gate must MEASURE
// the integration-covered surfaces (routes/mcp/agent/middleware), not just
// unit-tested services, and must BLOCK on a TIERED per-dir floor rather than one
// flat number. This pins the config so a future quiet edit that narrows the
// include back to services-only, or drops a tier, is caught.
//
// The actual "the gate clears these floors" + "the gate blocks when a floor is
// breached" proofs are the real `vitest run --coverage` runs exercised during the
// spec-390 build (recorded in the QA report); this source guard pins the config
// that those runs enforce. Tagged to spec-390 ac-5.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tagAc } from "@memex-ai-ac/vitest";

const AC_SERVER_TIERS = "mindset-prod/memex-building-itself/specs/spec-390/acs/ac-5";
const AC_SERVER_BLOCKS = "mindset-prod/memex-building-itself/specs/spec-390/acs/ac-6";

const configSrc = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "vitest.config.ts"),
  "utf8",
);

// Isolate the coverage block so include/threshold assertions can't accidentally
// match the test `include` (`src/**/*.test.ts`) higher up in the file.
const coverageBlock = configSrc.slice(configSrc.indexOf("coverage:"));
// The thresholds value is a ternary — `thresholds: isShardRun ? {collect-only
// zeros} : {full tiered}` (spec-390 shard guard). Anchor on the LIVE (tiered)
// branch — the `: {` that precedes the global tiered object — so the default-tier
// assertions read the real floors, never the collect-only zeros that come first.
// The per-glob keys (`"src/services/**":`) only exist in the tiered branch anyway.
const ternaryAt = coverageBlock.indexOf("thresholds: isShardRun");
const liveBranchAt =
  ternaryAt >= 0
    ? coverageBlock.indexOf(": {", ternaryAt) // start of the non-shard branch
    : coverageBlock.indexOf("thresholds:"); // fallback: no ternary present
const thresholdsBlock = coverageBlock.slice(liveBranchAt);

/** Extract the metrics of one per-glob (or default) threshold object. */
function tierFor(globOrNull: string | null): Record<string, number> {
  // For a glob, anchor on the quoted key WITH its trailing colon (threshold-only);
  // for the default, anchor at the start of the live tiered branch.
  const anchor = globOrNull
    ? thresholdsBlock.indexOf(`"${globOrNull}":`)
    : 0;
  const slice = thresholdsBlock.slice(anchor, anchor + 160);
  const grab = (m: string) => {
    const r = slice.match(new RegExp(`${m}:\\s*(\\d+)`));
    return r ? Number(r[1]) : Number.NaN;
  };
  return {
    lines: grab("lines"),
    functions: grab("functions"),
    branches: grab("branches"),
    statements: grab("statements"),
  };
}

describe("spec-390 ac-5: server coverage include spans the integration-covered surfaces", () => {
  it("includes services, routes, mcp, agent and middleware (not services-only)", () => {
    tagAc(AC_SERVER_TIERS);
    for (const dir of ["services", "routes", "mcp", "agent", "middleware"]) {
      expect(coverageBlock).toContain(`"src/${dir}/**/*.ts"`);
    }
  });
});

describe("spec-390 ac-5: server thresholds are tiered per-glob at the honest baseline", () => {
  it("preserves the original t-17 services floor exactly (80/80/70/80)", () => {
    tagAc(AC_SERVER_TIERS);
    expect(tierFor("src/services/**")).toEqual({
      lines: 80,
      functions: 80,
      branches: 70,
      statements: 80,
    });
  });

  it("holds middleware at the high logic tier (85/85/80/85)", () => {
    tagAc(AC_SERVER_TIERS);
    expect(tierFor("src/middleware/**")).toEqual({
      lines: 85,
      functions: 85,
      branches: 80,
      statements: 85,
    });
  });

  it("sets the presentational/glue ratchet floors (agent/routes/mcp)", () => {
    tagAc(AC_SERVER_TIERS);
    expect(tierFor("src/agent/**")).toEqual({
      lines: 72,
      functions: 70,
      branches: 60,
      statements: 72,
    });
    expect(tierFor("src/routes/**")).toEqual({
      lines: 68,
      functions: 65,
      branches: 55,
      statements: 68,
    });
    expect(tierFor("src/mcp/**")).toEqual({
      lines: 55,
      functions: 65,
      branches: 40,
      statements: 55,
    });
  });

  it("carries a top-level default catch-all floor (the gate BLOCKS, not reports)", () => {
    tagAc(AC_SERVER_TIERS);
    // The default thresholds (first metrics in the coverage block) gate any
    // included file not matched by a per-glob tier. A non-zero default proves
    // the gate is enforcing, not info-only.
    const def = tierFor(null);
    expect(def.branches).toBeGreaterThan(0);
    expect(def.lines).toBeGreaterThan(0);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// ac-6 — the gate BLOCKS, not merely reports. The empirical proof is the real
// `vitest run --coverage` runs exercised during the spec-390 build (recorded in
// the QA report): the suite exits 0 at these floors, and exits NON-ZERO when a
// tier is over-raised above its dir's actual (the mcp-branches=99 over-raise
// produced "Coverage for branches … does not meet 'src/mcp/**' threshold"). This
// guard pins the structural precondition for that blocking: every tier — default
// and every per-glob — carries non-zero floors, so vitest's checkThresholds
// actually enforces. A zeroed tier would silently turn the gate into a no-op
// report, exactly the failure spec-390 exists to prevent.
// ──────────────────────────────────────────────────────────────────────────
describe("spec-390 ac-6: every tier is enforcing (non-zero), so the gate can block", () => {
  it("default and all per-glob floors are strictly positive on all four metrics", () => {
    tagAc(AC_SERVER_BLOCKS);
    const tiers = [
      tierFor(null),
      tierFor("src/services/**"),
      tierFor("src/middleware/**"),
      tierFor("src/agent/**"),
      tierFor("src/routes/**"),
      tierFor("src/mcp/**"),
    ];
    for (const t of tiers) {
      expect(t.lines).toBeGreaterThan(0);
      expect(t.functions).toBeGreaterThan(0);
      expect(t.branches).toBeGreaterThan(0);
      expect(t.statements).toBeGreaterThan(0);
    }
  });
});
