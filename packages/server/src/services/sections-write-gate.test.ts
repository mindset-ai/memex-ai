// spec-161 — the section-write doc-type gate (ac-9). Pure truth table over
// (isStandard x hasContent x hasClauses): a standard takes clauses, everything else
// takes content, and every mismatch throws a redirecting error. No DB, no tool harness.

import { describe, it, expect } from "vitest";
import { resolveSectionWriteMode } from "./sections.js";
import { ValidationError } from "../types/errors.js";
import { tagAc } from "@memex-ai-ac/vitest";

const AC = (n: number) =>
  `mindset-prod/memex-building-itself/specs/spec-161/acs/ac-${n}`;

describe("spec-161: section-write doc-type gate (ac-9)", () => {
  it("a standard accepts clauses and rejects a prose content blob", () => {
    tagAc(AC(9));
    expect(
      resolveSectionWriteMode({ isStandard: true, hasContent: false, hasClauses: true }),
    ).toBe("clauses");
    expect(() =>
      resolveSectionWriteMode({ isStandard: true, hasContent: true, hasClauses: false }),
    ).toThrow(/clauses/i);
    // the redirect names the right field
    expect(() =>
      resolveSectionWriteMode({ isStandard: true, hasContent: true, hasClauses: false }),
    ).toThrow(ValidationError);
  });

  it("a standard with neither content nor clauses is rejected", () => {
    tagAc(AC(9));
    expect(() =>
      resolveSectionWriteMode({ isStandard: true, hasContent: false, hasClauses: false }),
    ).toThrow(/clauses/i);
  });

  it("a non-standard accepts content and rejects clauses", () => {
    tagAc(AC(9));
    expect(
      resolveSectionWriteMode({ isStandard: false, hasContent: true, hasClauses: false }),
    ).toBe("content");
    expect(() =>
      resolveSectionWriteMode({ isStandard: false, hasContent: false, hasClauses: true }),
    ).toThrow(/only standards have clauses/i);
  });

  it("a non-standard with neither is rejected", () => {
    tagAc(AC(9));
    expect(() =>
      resolveSectionWriteMode({ isStandard: false, hasContent: false, hasClauses: false }),
    ).toThrow(/content.*required/i);
  });

  it("supplying both content and clauses is rejected for any doc type", () => {
    tagAc(AC(9));
    expect(() =>
      resolveSectionWriteMode({ isStandard: true, hasContent: true, hasClauses: true }),
    ).toThrow(/exactly one/i);
    expect(() =>
      resolveSectionWriteMode({ isStandard: false, hasContent: true, hasClauses: true }),
    ).toThrow(/exactly one/i);
  });
});
