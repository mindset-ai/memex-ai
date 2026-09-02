// spec-544 dec-4 / ac-17 — every artifact this Spec ships stays on the fair-code
// side of the licence boundary.
//
// In this repo the FILE PATH *is* the licence marker: `.ee.` in a filename or
// `.ee` as a directory name means the Memex Enterprise License, everything else
// the Sustainable Use License. Adding or removing the marker RE-LICENSES the file,
// which is why std-25 makes the tier a Decision taken up front rather than a
// property discovered during review. dec-4 resolved spec-544 to fair-code core:
// std-25 cl-58 (infrastructure / build / CI) and cl-61 (cross-cutting plumbing)
// exempt most of it, and the one customer-visible part — the attribution surface —
// fails all three of cl-50's EE justifications. The clearest signal: this Spec
// exists because ONE organisation runs two repos against one Memex, which is a
// self-hoster's problem, not an enterprise-procurement one.
//
// So this guard is cheap and its value is entirely in the future: it fails the
// day someone moves one of these files under an `.ee` directory or renames it
// with the marker, which would silently paywall the standards index.

import { describe, it, expect } from "vitest";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tagAc } from "@memex-ai-ac/vitest";

const AC17 = "mindset-prod/memex-building-itself/specs/spec-544/acs/ac-17";
const REPO_ROOT = join(__dirname, "..", "..", "..", "..");

// Every file spec-544 adds or changes in this repo. Listed explicitly rather than
// derived from a git diff: a diff-based guard stops meaning anything the moment
// the branch merges, whereas these paths keep being checked forever.
const SPEC_544_FILES = [
  "scripts/ci/standards-index.mjs",
  "scripts/ci/standards-index.d.mts",
  "standards.manifest.json",
  "CLAUDE.md",
  "Makefile",
  ".github/actions/standards-index/action.yml",
  ".github/workflows/standards-drift.yml",
  "packages/server/src/__regression__/spec-544-standards-live-plan.regression.test.ts",
  "packages/server/src/__regression__/spec-544-standards-live-fetch.regression.test.ts",
  "packages/server/src/__regression__/spec-544-standards-check-stays-offline.regression.test.ts",
  "packages/server/src/__regression__/spec-544-standards-drift-workflow.regression.test.ts",
  "packages/server/src/__regression__/spec-544-one-curation-home.regression.test.ts",
  "packages/server/src/__regression__/spec-544-fair-code-boundary.regression.test.ts",
  "packages/server/src/services/standards-attribution.spec-544.integration.test.ts",
  "packages/shared/src/scaffold-data.ts",
  "packages/shared/src/scaffold-data.spec-544-attribution-button.test.ts",
  "packages/ui/src/pages/StandardList.tsx",
  "packages/ui/src/pages/StandardList.attribution.spec-544.test.tsx",
  "packages/ui/src/pages/Standard.tsx",
  "packages/ui/src/pages/Standard.attribution-handoff.spec-544.test.ts",
  "packages/ui/e2e/journey-72-spec-544-standards-attribution.spec.ts",
] as const;

/** The repo's licence marker: `.ee.` in a filename, or `.ee` as a path segment. */
const EE_MARKER = /(^|\/)\.ee(\/|$)|\.ee\./;

describe("spec-544: every artifact stays fair-code (ac-17)", () => {
  it("carries no EE licence marker on any path", () => {
    tagAc(AC17);

    const marked = SPEC_544_FILES.filter((p) => EE_MARKER.test(p));
    expect(
      marked,
      `These spec-544 files sit behind the Enterprise License:\n  ${marked.join("\n  ")}\n\n` +
        `dec-4 resolved this Spec to fair-code core. The file path IS the licence ` +
        `marker here, so moving one of these under an \`.ee\` directory or renaming ` +
        `it with \`.ee.\` re-licenses it — and would paywall the standards index a ` +
        `self-hoster is meant to get for free.`,
    ).toEqual([]);
  });

  it("still points at files that exist — the guard cannot go vacuous", () => {
    tagAc(AC17);

    // Without this, a rename would empty the list above and the guard would pass
    // by checking nothing. That is the failure mode a path allow-list invites, so
    // it is closed here rather than trusted.
    const missing = SPEC_544_FILES.filter((p) => !existsSync(join(REPO_ROOT, p)));
    expect(
      missing,
      `Listed but absent:\n  ${missing.join("\n  ")}\n\n` +
        `Either the file moved (update this list — and check the new path for an ` +
        `EE marker while you are there) or it was deleted.`,
    ).toEqual([]);
    expect(SPEC_544_FILES.length).toBeGreaterThan(15);
  });

  it("proves the marker regex actually detects a marker", () => {
    tagAc(AC17);

    // A guard whose matcher is broken passes against anything. Assert the regex
    // catches the real forms before trusting its silence on the list above.
    for (const ee of [
      "packages/server/src/.ee/slack/oauth.ts",
      "packages/server/src/services/billing.ee.ts",
      ".ee/anything.ts",
      "a/b/.ee",
    ]) {
      expect(EE_MARKER.test(ee), `must flag "${ee}" as EE`).toBe(true);
    }
    for (const free of [
      "scripts/ci/standards-index.mjs",
      "packages/ui/src/pages/Standard.tsx",
      "packages/server/src/services/free.ts",
    ]) {
      expect(EE_MARKER.test(free), `must NOT flag "${free}"`).toBe(false);
    }
  });
});
