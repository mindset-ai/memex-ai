// spec-207 — the AC coverage summary an agent reads to judge "is this Spec
// done?" must lead with the gap, never flatter a partial result, and never let
// a filter hide untested ACs. These pin `formatAcCoverageSummary` (the single
// helper both renderers now route through, dec-1) so the contract can't drift
// back to the "verified (of covered)" trophy that caused the spec-201
// false-done.
//
// Pure-function assertions (no DB) — the helper is pure over the rows it's
// handed. Tagged to the spec's three scope ACs so a green run flips them
// verified on prod (the dogfood loop).

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { tagAc } from "@memex-ai-ac/vitest";
import { formatAcCoverageSummary } from "../agent/tool-specs.js";
import type { AcWithVerification, VerificationState } from "../services/acs.js";

const SPEC = "mindset-prod/memex-building-itself/specs/spec-207";
const acRef = (n: number) => `${SPEC}/acs/ac-${n}`;

const TOOL_SPECS_SRC = readFileSync(
  join(__dirname, "..", "agent", "tool-specs.ts"),
  "utf-8",
);

// A non-untested state implies the AC carries at least one test event; untested
// implies none. `covered` keys off tests.length, so mirror that here.
function makeAc(seq: number, state: VerificationState): AcWithVerification {
  return {
    ac: {
      seq,
      kind: "scope",
      statement: `claim ${seq}`,
      status: "active",
    } as unknown as AcWithVerification["ac"],
    canonicalRef: acRef(seq),
    tests:
      state === "untested"
        ? []
        : ([{ testIdentifier: `t-${seq}`, latestStatus: "pass", runCount: 1 }] as unknown as AcWithVerification["tests"]),
    verificationState: state,
    daysSinceLastRun: state === "untested" ? null : 1,
    parents: [],
  };
}

// ──────────────────────────────────────────────────────────────────────────
// ac-1 — leads with the not-verified gap and its AC handles.
// ──────────────────────────────────────────────────────────────────────────
describe("ac-1 — summary leads with the gap, by handle", () => {
  it("opens with the not-verified count and the failing/untested handles", () => {
    tagAc(acRef(1));
    const out = formatAcCoverageSummary([
      makeAc(1, "verified"),
      makeAc(2, "untested"),
      makeAc(3, "failing"),
      makeAc(4, "stale"),
    ]);
    expect(out).toBe("2 of 4 ACs NOT VERIFIED: ac-2 ac-3 · 75% covered (of 4)");
  });

  it("names only the not-verified ACs — verified handles never appear in the lead", () => {
    tagAc(acRef(1));
    const out = formatAcCoverageSummary([
      makeAc(1, "verified"),
      makeAc(5, "untested"),
    ]);
    expect(out.startsWith("1 of 2 ACs NOT VERIFIED: ac-5")).toBe(true);
    expect(out).not.toContain("ac-1");
  });

  it("treats stale and accepted as covered, not as gaps (mirrors the nag footer)", () => {
    tagAc(acRef(1));
    const out = formatAcCoverageSummary([
      makeAc(1, "stale"),
      makeAc(2, "accepted"),
    ]);
    expect(out).toBe("0 of 2 ACs not verified · 100% covered (of 2)");
  });
});

// ──────────────────────────────────────────────────────────────────────────
// ac-2 — no "verified (of covered)" trophy; percentages over total.
// ──────────────────────────────────────────────────────────────────────────
describe("ac-2 — no self-selecting trophy metric", () => {
  it("a partially covered Spec never reads as 100% verified", () => {
    tagAc(acRef(2));
    const out = formatAcCoverageSummary([
      makeAc(1, "verified"),
      makeAc(2, "untested"),
      makeAc(3, "untested"),
      makeAc(4, "untested"),
    ]);
    expect(out).toBe(
      "3 of 4 ACs NOT VERIFIED: ac-2 ac-3 ac-4 · 25% covered (of 4)",
    );
    expect(out).not.toMatch(/100%/);
    expect(out).not.toMatch(/verified \(of covered\)/);
  });

  it("denominates the coverage percentage over total, not the covered subset", () => {
    tagAc(acRef(2));
    // 1 covered of 4 → 25% (over total). The old trophy would have shown the
    // single covered AC as 100% verified-of-covered.
    const out = formatAcCoverageSummary([
      makeAc(1, "verified"),
      makeAc(2, "untested"),
      makeAc(3, "untested"),
      makeAc(4, "untested"),
    ]);
    expect(out).toContain("25% covered (of 4)");
  });
});

// ──────────────────────────────────────────────────────────────────────────
// ac-3 — a filter can't silently hide active ACs.
// ──────────────────────────────────────────────────────────────────────────
describe("ac-3 — filtered views surface what they hide", () => {
  it("states how many active ACs fall outside the filter", () => {
    tagAc(acRef(3));
    const out = formatAcCoverageSummary([makeAc(1, "untested")], {
      hiddenByFilter: 5,
    });
    expect(out).toBe(
      "1 of 1 AC NOT VERIFIED: ac-1 · 0% covered (of 1) · ⚠ 5 active ACs outside this filter (not counted above)",
    );
  });

  it("singularises the warning and omits it when nothing is hidden", () => {
    tagAc(acRef(3));
    expect(
      formatAcCoverageSummary([makeAc(1, "verified")], { hiddenByFilter: 1 }),
    ).toContain("⚠ 1 active AC outside this filter (not counted above)");
    expect(
      formatAcCoverageSummary([makeAc(1, "verified")], { hiddenByFilter: 0 }),
    ).not.toContain("outside this filter");
    expect(formatAcCoverageSummary([makeAc(1, "verified")])).not.toContain(
      "outside this filter",
    );
  });
});

// ──────────────────────────────────────────────────────────────────────────
// ac-4 (dec-1) — one shared helper, consumed by both renderers, no trophy.
// Source-text wiring assertions: the runtime contract is pinned above; this
// guards that BOTH call sites actually route through the single helper and that
// the "verified (of covered)" computation is gone from the file entirely.
// ──────────────────────────────────────────────────────────────────────────
describe("ac-4 — single shared helper consumed by both call sites", () => {
  it("exports one formatAcCoverageSummary helper", () => {
    tagAc(acRef(4));
    expect(TOOL_SPECS_SRC).toMatch(/export function formatAcCoverageSummary\(/);
  });

  it("formatCoverageHeader routes its headline through the helper", () => {
    tagAc(acRef(4));
    expect(TOOL_SPECS_SRC).toMatch(
      /\*\*AC coverage:\*\* \$\{formatAcCoverageSummary\(active\)\}/,
    );
  });

  it("the list_acs handler routes its headline through the helper, with the filter delta", () => {
    tagAc(acRef(4));
    expect(TOOL_SPECS_SRC).toMatch(
      /formatAcCoverageSummary\(rows,\s*\{\s*hiddenByFilter\s*\}\)/,
    );
  });

  it("the 'verified (of covered)' trophy computation is gone from the whole file", () => {
    tagAc(acRef(4));
    // Target the computed metric (`${pct}% verified (of covered)`), not prose
    // mentions of the phrase in the helper's own explanatory comments.
    expect(TOOL_SPECS_SRC).not.toMatch(/% verified \(of covered\)/);
  });
});
