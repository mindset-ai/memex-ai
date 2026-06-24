// spec-340 t-8 — the deterministic path→facet cross-check. Pure functions, no DB,
// no LLM (a plain unit test).

import { describe, it, expect } from "vitest";
import { tagAc } from "@memex-ai-ac/vitest";
import { facetsImpliedByPaths, crossCheckBallot } from "./facet-crosscheck.js";

const SPEC = "mindset-prod/memex-building-itself/specs/spec-340";
const AC = (n: number) => `${SPEC}/acs/ac-${n}`;

describe("path→facet cross-check (spec-340 t-8)", () => {
  it("flags a ballot that contradicts the diff and records the mismatch rate (ac-10)", () => {
    tagAc(AC(10));
    const paths = ["packages/server/drizzle/0107_add_facets.sql"];

    // The canonical case: a migration in the diff, but db-migrations marked false.
    const contradicting = crossCheckBallot(paths, { "db-migrations": false, security: true });
    expect(contradicting.impliedFacets).toContain("db-migrations");
    expect(contradicting.mismatches).toContain("db-migrations");
    expect(contradicting.mismatchRate).toBeGreaterThan(0); // the integrity metric

    // Honest ballot: db-migrations marked true → no mismatch.
    const honest = crossCheckBallot(paths, { "db-migrations": true });
    expect(honest.mismatches).toEqual([]);
    expect(honest.mismatchRate).toBe(0);
  });

  it("derives implied facets deterministically from well-known path signatures (ac-10)", () => {
    tagAc(AC(10));
    expect(facetsImpliedByPaths(["packages/ui/e2e/login.spec.ts"])).toEqual(
      expect.arrayContaining(["e2e-testing"]),
    );
    expect(facetsImpliedByPaths(["src/services/foo.test.ts"])).toContain("test-coverage");
    expect(facetsImpliedByPaths([".github/workflows/ci.yml"])).toContain("ci-pr-process");
    expect(facetsImpliedByPaths(["README.md"])).toContain("documentation");
    expect(facetsImpliedByPaths(["package.json"])).toContain("dependencies");

    // Deterministic — same input, same output (no LLM, no randomness).
    const a = facetsImpliedByPaths(["src/db/migrations/x.sql", "e2e/y.feature"]);
    const b = facetsImpliedByPaths(["src/db/migrations/x.sql", "e2e/y.feature"]);
    expect(a).toEqual(b);
  });

  it("is a PARTIAL backstop — an ordinary source path implies nothing (default-facet-only) (ac-10)", () => {
    tagAc(AC(10));
    // A plain implementation file has no product-level signature → no implication,
    // so a custom org facet can never be validated by the cross-check.
    expect(facetsImpliedByPaths(["src/services/orders.ts"])).toEqual([]);
    const r = crossCheckBallot(["src/services/orders.ts"], { security: false });
    expect(r.impliedFacets).toEqual([]);
    expect(r.mismatchRate).toBe(0); // nothing implied → nothing to contradict
  });
});
