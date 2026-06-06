// Journey-inventory guard for the spec-172 e2e rebuild (ac-2 + ac-6).
//
// Sibling of spec-172-e2e-schema-drift.static-scan.test.ts (same deliberate
// cross-package fs walk — see that file's header for why this lives in the
// server's __regression__ tree rather than the ui package).
//
// The two scope ACs this file gives a standing, self-reporting guard:
//
//   ac-2 — "Every account-era journey (1, 2, 3, 4, 6, 7) has an explicit
//           recorded disposition — ported … parked … or deleted — none is left
//           silently failing or silently skipped."
//          dec-1 recorded the disposition: all six DELETED, their underlying
//          flows re-covered by fresh tenancy journeys (ac-5). The standing,
//          repo-checkable shape of that disposition is therefore: the six
//          account-era files stay dead, AND the six tenancy replacements stay
//          present. A future PR resurrecting an account-era journey (or
//          dropping a tenancy journey without a successor) trips this guard
//          instead of silently un-recording the disposition.
//
//   ac-6 — "The 12 retained journeys (5, 8–18) run on the rebuilt e2e base
//           (new fixtures/seed mechanism) … none passes vacuously or asserts
//           retired UI."
//          The build-phase half (each journey individually sanity-checked
//          against the current UI) was human/agent judgement; the standing
//          half asserted here is structural: all 12 retained journey files
//          exist, import ONLY the rebuilt foundation (./helpers — never the
//          pre-0038 helpers/db / reactivity-fixtures / a postgres driver),
//          and carry no test.skip / test.fixme / describe.skip — so none can
//          quietly become a vacuous pass or a silent skip. (The "passes on a
//          cold DB" half is the e2e job itself — ac-1's emission.)
//
// The per-file CONTENT rot (dropped-table SQL, subdomain URLs) is the
// static-scan sibling's job (ac-7/ac-3); this file owns the INVENTORY shape.

import { describe, it, expect } from "vitest";
import { tagAc } from "@memex-ai-ac/vitest";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

const AC = "mindset-prod/memex-building-itself/specs/spec-172/acs";

// packages/server/src/__regression__ -> packages/ui/e2e
const E2E_DIR = join(__dirname, "..", "..", "..", "ui", "e2e");

// dec-1: the six account-era journeys, deleted outright (never ported).
const DELETED_ACCOUNT_ERA = [
  "journey-1-account-creation",
  "journey-2-team-invite",
  "journey-3-auto-grouping",
  "journey-4-multi-account",
  "journey-6-member-management",
  "journey-7-domain-conflict",
];

// ac-5: the fresh tenancy set that re-covers the six deleted flows.
const TENANCY_REPLACEMENTS = [
  "tenancy-1-org-creation.spec.ts",
  "tenancy-2-invite-accept.spec.ts",
  "tenancy-3-domains-autogrouping.spec.ts",
  "tenancy-4-switching.spec.ts",
  "tenancy-5-member-management.spec.ts",
  "tenancy-6-domain-conflict.spec.ts",
];

// ac-6: the 12 retained journeys, re-based onto the new foundation.
const RETAINED = [
  "journey-5-external-sharing.spec.ts",
  "journey-8-agent-chat-streaming.spec.ts",
  "journey-9-agent-tool-use.spec.ts",
  "journey-10-primary-nav.spec.ts",
  "journey-11-plan-submit-approve.spec.ts",
  "journey-12-cross-tab-drift.spec.ts",
  "journey-13-spec-tab-filtering.spec.ts",
  "journey-14-candidate-decision.spec.ts",
  "journey-15-spec-detail-layout.spec.ts",
  "journey-16-reactivity.spec.ts",
  "journey-17-spec-role-controls.spec.ts",
  "journey-18-global-search.spec.ts",
];

// Pre-0038 foundation imports that must never come back into a journey.
const RETIRED_IMPORTS = [
  /from\s+["']\.\/helpers\/db(\.js)?["']/,
  /from\s+["']\.\/helpers\/db-memex(\.js)?["']/,
  /from\s+["']\.\/helpers\/reactivity-fixtures(\.js)?["']/,
  /from\s+["']postgres["']/,
];

// Silent-skip shapes — a retained journey must run, not vacuously report.
const SKIP_SHAPES = [/\btest\.skip\(/, /\btest\.fixme\(/, /\bdescribe\.skip\(/, /\btest\.only\(/];

function specFiles(): string[] {
  return readdirSync(E2E_DIR).filter((f) => f.endsWith(".spec.ts"));
}

describe("spec-172 ac-2: account-era journey dispositions stay recorded in the tree", () => {
  it("the six deleted account-era journeys stay dead — no file resurrects their names", () => {
    tagAc(`${AC}/ac-2`);
    const present = specFiles();
    for (const dead of DELETED_ACCOUNT_ERA) {
      const resurrected = present.filter((f) => f.startsWith(dead));
      expect(
        resurrected,
        `${dead}* reappeared in packages/ui/e2e — dec-1 recorded these as DELETED; ` +
          `a successor flow belongs in the tenancy-N set or a NEW journey name, ` +
          `not a resurrected account-era file`,
      ).toEqual([]);
    }
  });

  it("each deleted flow's tenancy replacement is present (deleted ≠ dropped: dec-1 re-covered all six)", () => {
    tagAc(`${AC}/ac-2`);
    const present = new Set(specFiles());
    for (const replacement of TENANCY_REPLACEMENTS) {
      expect(
        present.has(replacement),
        `${replacement} is missing — it is the recorded successor of a deleted ` +
          `account-era journey (dec-1/ac-5); removing it un-records the disposition`,
      ).toBe(true);
    }
  });
});

describe("spec-172 ac-6: the 12 retained journeys live on the rebuilt foundation", () => {
  it("all 12 retained journey files exist", () => {
    tagAc(`${AC}/ac-6`);
    for (const f of RETAINED) {
      expect(existsSync(join(E2E_DIR, f)), `${f} is missing from packages/ui/e2e`).toBe(true);
    }
  });

  it("retained journeys import only the rebuilt foundation — no pre-0038 helpers, no postgres", () => {
    tagAc(`${AC}/ac-6`);
    for (const f of RETAINED) {
      const src = readFileSync(join(E2E_DIR, f), "utf8");
      for (const retired of RETIRED_IMPORTS) {
        expect(
          retired.test(src),
          `${f} imports a retired pre-0038 module (${retired}) — journeys seed only ` +
            `through the test-only HTTP surface [per std-28 cl-5]`,
        ).toBe(false);
      }
    }
  });

  it("no retained journey is silently skipped, fixme'd, or .only'd", () => {
    tagAc(`${AC}/ac-6`);
    for (const f of RETAINED) {
      const src = readFileSync(join(E2E_DIR, f), "utf8");
      for (const shape of SKIP_SHAPES) {
        expect(
          shape.test(src),
          `${f} carries ${shape} — a retained journey that doesn't run is exactly ` +
            `the silent rot ac-6 exists to prevent; fix it or surface an Issue, ` +
            `don't park it`,
        ).toBe(false);
      }
    }
  });
});

describe("spec-172 journey-inventory meta-tests (the guard itself trips)", () => {
  it("the skip-shape scanner trips on a fixme'd test body", () => {
    const sample = `test.fixme("parked", async () => {});`;
    expect(SKIP_SHAPES.some((s) => s.test(sample))).toBe(true);
  });

  it("the retired-import scanner trips on a helpers/db import", () => {
    const sample = `import { seedAccount } from "./helpers/db.js";`;
    expect(RETIRED_IMPORTS.some((s) => s.test(sample))).toBe(true);
  });
});
