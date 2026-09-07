// spec-550 dec-5 (ac-9) — this Spec is fair-code (Sustainable Use License), NOT
// Enterprise Edition. The licence marker in this repo IS the file path, so the guard is
// a scan of the paths this Spec touched. Mirrors spec-500 / spec-545 and shares their
// predicate (./licence-marker.ts) rather than restating it — two definitions that drift
// would disagree about something with legal consequences [per std-51].

import { describe, it, expect } from "vitest";
import { tagAc } from "@memex-ai-ac/vitest";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { eeMarkedAmong } from "./licence-marker.js";

const AC_9 = "mindset-prod/memex-building-itself/specs/spec-550/acs/ac-9";

const REPO_ROOT = join(__dirname, "../../../..");

// Every file spec-550 introduces or edits, repo-relative. All must be fair-code.
const SPEC_550_FILES = [
  "packages/server/src/services/facet-routing.ts",
  "packages/server/src/services/facet-routing.integration.test.ts",
  "packages/server/src/services/facet-routing-readout.spec-550.test.ts",
  "packages/server/src/services/facet-rerank.ts",
  "packages/server/src/__regression__/spec-550-fair-code.static-scan.regression.test.ts",
  "packages/server/src/__regression__/spec-550-readout-single-author.regression.test.ts",
];

describe("spec-550 is fair-code — no EE markers (ac-9)", () => {
  it("every spec-550 file exists and carries no .ee. / .ee marker", () => {
    tagAc(AC_9);

    // Existence first: this is what catches a later MOVE across the licence line.
    const missing = SPEC_550_FILES.filter((f) => !existsSync(join(REPO_ROOT, f)));
    expect(missing, `spec-550 files not found (moved or renamed?): ${missing.join(", ")}`).toEqual([]);

    const eeMarked = eeMarkedAmong(SPEC_550_FILES);
    expect(
      eeMarked,
      `spec-550 is fair-code (dec-5), but these paths are EE-marked: ${eeMarked.join(", ")}`,
    ).toEqual([]);
  });
});
