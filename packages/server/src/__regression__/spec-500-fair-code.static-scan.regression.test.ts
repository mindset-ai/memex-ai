// spec-500 dec-7 (ac-15) — this Spec is fair-code (Sustainable Use License), NOT
// Enterprise Edition. The license marker in this repo IS the file path: a `.ee.`
// filename or a `.ee/` dirname re-licenses a file as EE. This static scan is the
// regression guard that every file spec-500 introduced/edited stays fair-code:
// none is EE-marked. If a future edit moves any of them across the license line,
// this fails loudly and names the file.
//
// The marker predicate itself lives in ./licence-marker.ts — spec-545 became its second
// consumer, and one definition of "which licence does this file ship under" is worth
// more than two copies that can drift.

import { describe, it, expect } from "vitest";
import { tagAc } from "@memex-ai-ac/vitest";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { eeMarkedAmong } from "./licence-marker.js";

const AC_FAIR_CODE = "mindset-prod/memex-building-itself/specs/spec-500/acs/ac-15";

// Repo root from this file: packages/server/src/__regression__ → ../../../..
const REPO_ROOT = join(__dirname, "../../../..");

// Every file spec-500 introduced or edited, repo-relative. All must be fair-code.
const SPEC_500_FILES = [
  "packages/server/src/db/schema.ts",
  "packages/server/src/services/users.ts",
  "packages/server/src/services/memexes.ts",
  "packages/server/src/services/users.featured-demo.integration.test.ts",
  "packages/server/src/routes/__test__.ts",
  "packages/server/scripts/set-featured-demo.ts",
  "packages/server/drizzle/0129_spec500_memex_is_featured_demo.sql",
  "packages/ui/src/components/MemexSwitcher.tsx",
  "packages/ui/src/components/MemexSwitcher.test.tsx",
  "packages/ui/src/api/auth.ts",
  "packages/ui/src/hooks/useMemexAccess.ts",
  "packages/ui/e2e/helpers/seed.ts",
  "packages/ui/e2e/helpers/index.ts",
  "packages/ui/e2e/journey-65-spec-500-explore-memex.spec.ts",
];

describe("spec-500 is fair-code — no EE markers (ac-15)", () => {
  it("every spec-500 file exists and carries no .ee. / .ee marker", () => {
    tagAc(AC_FAIR_CODE);

    const missing = SPEC_500_FILES.filter((f) => !existsSync(join(REPO_ROOT, f)));
    expect(missing, `spec-500 files not found (path drift?): ${missing.join(", ")}`).toEqual([]);

    const eeMarked = eeMarkedAmong(SPEC_500_FILES);
    expect(eeMarked, `spec-500 files must stay fair-code, but these are EE-marked: ${eeMarked.join(", ")}`).toEqual([]);
  });
});
