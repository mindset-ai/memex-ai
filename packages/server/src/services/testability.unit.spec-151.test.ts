// spec-151 dec-5 — the persisted testability verdict: shape, validation, and the
// clause-coverage denominator predicate. Pure (no DB / no LLM).

import { describe, it, expect } from "vitest";
import { tagAc } from "@memex-ai-ac/vitest";
import { standardClauses } from "../db/schema.js";
import {
  validateTestabilityVerdict,
  isCoverageCountable,
  TESTABILITY_ARCHETYPES,
} from "./testability.js";

const SPEC = "mindset-prod/memex-building-itself/specs/spec-151";
const AC = (n: number) => `${SPEC}/acs/ac-${n}`;

describe("testability verdict columns + shape (spec-151 dec-5)", () => {
  it("standard_clauses carries is_obligation, testable, archetype — and NO confidence column [ac-14]", () => {
    tagAc(AC(14));
    // Drizzle exposes each column as a property on the table object.
    expect(standardClauses.isObligation).toBeDefined();
    expect(standardClauses.testable).toBeDefined();
    expect(standardClauses.archetype).toBeDefined();
    // `confidence` is deliberately not persisted (spike-only triage signal).
    expect((standardClauses as unknown as Record<string, unknown>).confidence).toBeUndefined();
  });

  it("validates a testable verdict and requires a known archetype [ac-14]", () => {
    tagAc(AC(14));
    expect(
      validateTestabilityVerdict({ isObligation: true, testable: true, archetype: "grep-denylist" }),
    ).toEqual({ isObligation: true, testable: true, archetype: "grep-denylist" });

    // Testable but missing / unknown archetype → rejected (never a half-classified clause).
    expect(() => validateTestabilityVerdict({ isObligation: true, testable: true })).toThrow();
    expect(() =>
      validateTestabilityVerdict({ isObligation: true, testable: true, archetype: "made-up" }),
    ).toThrow();
  });

  it("forces archetype to null for a non-testable clause, whatever was passed [ac-14]", () => {
    tagAc(AC(14));
    expect(
      validateTestabilityVerdict({ isObligation: true, testable: false, archetype: "static-scan" }),
    ).toEqual({ isObligation: true, testable: false, archetype: null });
  });

  it("rejects a non-boolean obligation/testable", () => {
    expect(() =>
      validateTestabilityVerdict({ isObligation: "yes" as unknown, testable: true, archetype: "static-scan" }),
    ).toThrow();
    expect(() =>
      validateTestabilityVerdict({ isObligation: true, testable: 1 as unknown }),
    ).toThrow();
  });

  it("the coverage denominator counts ONLY testable obligations [ac-16]", () => {
    tagAc(AC(16));
    expect(isCoverageCountable({ isObligation: true, testable: true })).toBe(true);
    // A non-obligation, an untestable obligation, and an unclassified clause are all excluded.
    expect(isCoverageCountable({ isObligation: true, testable: false })).toBe(false);
    expect(isCoverageCountable({ isObligation: false, testable: true })).toBe(false);
    expect(isCoverageCountable({ isObligation: null, testable: null })).toBe(false);
  });

  it("exposes the seven ranked archetypes", () => {
    expect(TESTABILITY_ARCHETYPES).toContain("type-constraint");
    expect(TESTABILITY_ARCHETYPES).toContain("runtime-property");
    expect(TESTABILITY_ARCHETYPES).toHaveLength(7);
  });
});
