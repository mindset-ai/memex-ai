// b-90 ac-14 — the README's deployment / env-config section documents the
// new MEMEX_OWN_NAMESPACE env var.
//
// Covers: the variable name, expected values per env (mindset-int /
// mindset-prod), the consequence of leaving it unset (fail-closed), and
// the pointer to scripts/deploy-config.sh as the place where it's set.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { tagAc } from "@memex-ai-ac/vitest";

const README = join(__dirname, "..", "..", "..", "..", "README.md");
const src = readFileSync(README, "utf-8");

describe("b-90 ac-14: README documents MEMEX_OWN_NAMESPACE", () => {
  it("README contains a MEMEX_OWN_NAMESPACE entry in the env-vars table", () => {
    tagAc("mindset-prod/memex-building-itself/briefs/b-90/acs/ac-14");
    expect(src).toMatch(/MEMEX_OWN_NAMESPACE/);
  });

  it("README states the expected value mindset-int", () => {
    tagAc("mindset-prod/memex-building-itself/briefs/b-90/acs/ac-14");
    expect(src).toMatch(/mindset-int/);
  });

  it("README states the expected value mindset-prod", () => {
    tagAc("mindset-prod/memex-building-itself/briefs/b-90/acs/ac-14");
    expect(src).toMatch(/mindset-prod/);
  });

  it("README describes the fail-closed behaviour when the env var is unset", () => {
    tagAc("mindset-prod/memex-building-itself/briefs/b-90/acs/ac-14");
    // Wording can vary; the load-bearing claim is "unset → fail-closed / 4xx".
    expect(src).toMatch(/fail-closed|fail closed|returns 503|returns 4xx/i);
  });

  it("README points at scripts/deploy-config.sh as the place where it's set", () => {
    tagAc("mindset-prod/memex-building-itself/briefs/b-90/acs/ac-14");
    expect(src).toMatch(/scripts\/deploy-config\.sh/);
  });
});
