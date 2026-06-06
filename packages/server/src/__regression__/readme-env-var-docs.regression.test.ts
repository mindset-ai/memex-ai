// spec-90 ac-14 (A1) — MEMEX_OWN_NAMESPACE is removed, so the docs that
// described it are gone too. Regression guard: the README and DEVELOPMENT.md
// carry no MEMEX_OWN_NAMESPACE documentation. (The env var, its per-env values,
// and the fail-closed note went away with the mechanism.)

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { tagAc } from "@memex-ai-ac/vitest";

const REPO_ROOT = join(__dirname, "..", "..", "..", "..");
const README = join(REPO_ROOT, "README.md");
const DEVELOPMENT = join(REPO_ROOT, "DEVELOPMENT.md");

describe("spec-90 ac-14: docs no longer document MEMEX_OWN_NAMESPACE", () => {
  it("README.md contains no MEMEX_OWN_NAMESPACE reference", () => {
    tagAc("mindset-prod/memex-building-itself/specs/spec-90/acs/ac-14");
    expect(readFileSync(README, "utf-8")).not.toMatch(/MEMEX_OWN_NAMESPACE/);
  });

  it("DEVELOPMENT.md contains no MEMEX_OWN_NAMESPACE reference", () => {
    tagAc("mindset-prod/memex-building-itself/specs/spec-90/acs/ac-14");
    expect(readFileSync(DEVELOPMENT, "utf-8")).not.toMatch(/MEMEX_OWN_NAMESPACE/);
  });
});
