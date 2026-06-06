// spec-181 / ac-10 — the renamed type unions + guards carry 'specify' and no
// 'plan' phase value.
//
// The `plan` → `specify` rename touches the finite enums that describe the Spec
// pipeline. This test pins the SHAPE of those enums + guards so a regression
// (re-adding 'plan', or dropping 'specify') is caught at the type-system surface:
//
//   - SpecStatus / DocStatus unions   (types/roles.ts)
//   - SPEC_STATUSES / DOC_STATUSES    (the readonly array projections)
//   - isDocStatus / isSpecStatus      (the runtime guards)
//   - SpecPhase                       (@memex/shared spec-readiness)
//   - phaseFromStatus (via formatTerseSpecPhase) — incl. the legacy 'review'
//     case that must STILL map to 'specify'.
//
// The `plan` COMMENT TYPE is a different vocabulary and is deliberately left
// alone — asserted here to stay present so the rename didn't over-reach.

import { describe, it, expect } from "vitest";
import { tagAc } from "@memex-ai-ac/vitest";
import {
  DOC_STATUSES,
  SPEC_STATUSES,
  COMMENT_TYPES,
  isDocStatus,
  isSpecStatus,
} from "./roles.js";
import type { SpecPhase } from "@memex/shared";
import { isForwardTransition } from "@memex/shared";
import { formatTerseSpecPhase } from "../mcp/formatters.js";

const AC_10 = "mindset-prod/memex-building-itself/specs/spec-181/acs/ac-10";

describe("spec-181 ac-10: renamed phase unions/guards carry 'specify', not 'plan'", () => {
  it("SPEC_STATUSES contains 'specify' and not 'plan'", () => {
    tagAc(AC_10);
    expect(SPEC_STATUSES).toContain("specify");
    expect(SPEC_STATUSES as readonly string[]).not.toContain("plan");
    // The full Spec kanban vocabulary.
    expect([...SPEC_STATUSES].sort()).toEqual([
      "build",
      "done",
      "draft",
      "specify",
      "verify",
    ]);
  });

  it("DOC_STATUSES contains 'specify' and not 'plan' (legacy review/implementation stay)", () => {
    tagAc(AC_10);
    expect(DOC_STATUSES).toContain("specify");
    expect(DOC_STATUSES as readonly string[]).not.toContain("plan");
    // The legacy non-Spec values survive the rename.
    expect(DOC_STATUSES).toContain("review");
    expect(DOC_STATUSES).toContain("implementation");
  });

  it("isDocStatus / isSpecStatus accept 'specify' and reject 'plan'", () => {
    tagAc(AC_10);
    expect(isDocStatus("specify")).toBe(true);
    expect(isSpecStatus("specify")).toBe(true);
    expect(isDocStatus("plan")).toBe(false);
    expect(isSpecStatus("plan")).toBe(false);
  });

  it("the `plan` COMMENT TYPE is untouched (a different vocabulary)", () => {
    tagAc(AC_10);
    // The rename was phase-only; the typed-comment `plan` value stays.
    expect(COMMENT_TYPES).toContain("plan");
  });

  it("SpecPhase (@memex/shared) admits 'specify' and orders draft → specify → build", () => {
    tagAc(AC_10);
    // `specify` is a valid SpecPhase value (compile-time) and orders between
    // draft and build (runtime, via the PHASE_ORDER-backed transition guard).
    const draft: SpecPhase = "draft";
    const specify: SpecPhase = "specify";
    const build: SpecPhase = "build";
    expect(isForwardTransition(draft, specify)).toBe(true);
    expect(isForwardTransition(specify, build)).toBe(true);
    expect(isForwardTransition(build, specify)).toBe(false);
  });

  it("phaseFromStatus (via formatTerseSpecPhase): 'specify' renders; legacy 'review' STILL maps to specify; 'plan' is not a phase", () => {
    tagAc(AC_10);
    // 'specify' is a recognised phase and renders a phase line.
    const specifyLine = formatTerseSpecPhase("specify");
    expect(specifyLine).toBeTruthy();
    expect(specifyLine).toContain("Phase: specify");

    // Legacy 'review' must still map onto the specify phase (back-compat).
    const reviewLine = formatTerseSpecPhase("review");
    expect(reviewLine).toBeTruthy();
    expect(reviewLine).toContain("Phase: specify");

    // 'plan' is no longer a recognised phase value → no phase line.
    expect(formatTerseSpecPhase("plan")).toBeNull();
  });
});
