// spec-545 dec-3 (ac-14) — this Spec is fair-code (Sustainable Use License), NOT
// Enterprise Edition. The licence marker in this repo IS the file path, so the guard is
// a scan of the paths this Spec touched. Mirrors spec-500's guard and shares its
// predicate (./licence-marker.ts).
//
// WHY A FILE LIST AND NOT `git diff develop...HEAD`. ac-14 was written during specify
// naming a diff-based check, on the reasoning that a diff catches a RENAME across the
// licence line as well as an edit. Building it showed the diff is the weaker mechanism:
// it reads as vacuously green once this branch merges (develop...develop is empty), it
// depends on the `develop` ref being present, which a shallow CI checkout does not
// guarantee, and it therefore stops guarding anything the moment it matters most —
// later, when someone moves one of these files.
//
// The list-based form keeps the rename coverage the diff was chosen for, by a different
// route: moving a listed file into a `.ee/` directory makes its old path stop existing,
// and the existence assertion reds. It also keeps working forever, on any branch, with
// no git dependency. ac-14 was updated to describe this.
//
// Note the guard deliberately does NOT assert "no PR may touch EE files" — EE work is
// legitimate, it just needs a signed CLA. The claim here is narrower and true: the
// files THIS Spec owns are fair-code and stay that way.

import { describe, it, expect } from "vitest";
import { tagAc } from "@memex-ai-ac/vitest";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { eeMarkedAmong } from "./licence-marker.js";

const AC_14 = "mindset-prod/memex-building-itself/specs/spec-545/acs/ac-14";

// Repo root from this file: packages/server/src/__regression__ → ../../../..
const REPO_ROOT = join(__dirname, "../../../..");

// Every file spec-545 introduced or edited, repo-relative. All must be fair-code.
// (CLAUDE.md and standards.manifest.json also move on this branch, as regenerated
// standards-index output carried over from develop — not this Spec's own change, and
// neither can carry a path marker anyway.)
const SPEC_545_FILES = [
  "packages/server/src/db/default-facets.fixture.ts",
  "packages/server/src/db/default-facets.wording.spec-545.test.ts",
  "packages/server/src/db/default-facets.portability.test.ts",
  "packages/server/src/db/default-standards.portability.test.ts",
  "packages/server/src/db/portability-scan.ts",
  "packages/server/scripts/backfill-facet-tags.ts",
  "packages/server/src/services/default-facets-no-overwrite.spec-545.integration.test.ts",
  "packages/server/src/__regression__/facet-backfill-gap-only-default.spec-545.regression.test.ts",
  "packages/server/src/__regression__/licence-marker.ts",
  "packages/server/src/__regression__/spec-545-fair-code.static-scan.regression.test.ts",
];

describe("spec-545 is fair-code — no EE markers (ac-14)", () => {
  it("every spec-545 file exists and carries no .ee. / .ee marker", () => {
    tagAc(AC_14);

    // Existence first: this is what catches a later MOVE across the licence line, and
    // it also keeps the list honest against ordinary path drift.
    const missing = SPEC_545_FILES.filter((f) => !existsSync(join(REPO_ROOT, f)));
    expect(missing, `spec-545 files not found (moved or renamed?): ${missing.join(", ")}`).toEqual([]);

    const eeMarked = eeMarkedAmong(SPEC_545_FILES);
    expect(
      eeMarked,
      `spec-545 is fair-code (dec-3), but these paths are EE-marked: ${eeMarked.join(", ")}`,
    ).toEqual([]);
  });

  it("the marker predicate actually recognises both marker shapes (guards the guard)", () => {
    tagAc(AC_14);
    // Without this, a predicate that always returned false would keep every fair-code
    // assertion green forever.
    expect(
      eeMarkedAmong([
        "packages/server/src/services/.ee/slack/client.ts", // dirname marker
        "packages/server/src/routes/auth/thing.ee.ts", // filename marker
        "packages/server/src/db/default-facets.fixture.ts", // fair-code
        "packages/server/src/tree.ee-old/thing.ts", // NOT the marker — segment must be exactly .ee
      ]),
    ).toEqual([
      "packages/server/src/services/.ee/slack/client.ts",
      "packages/server/src/routes/auth/thing.ee.ts",
    ]);
  });
});
