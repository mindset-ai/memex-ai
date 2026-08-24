// spec-538 t-6 (ac-27, ac-28, ac-26, ac-4) — the number, and the two bounds that
// keep it honest.
//
// This Spec exists partly because `mcp/tools.ts:342` asserts a bound the read
// path does not hold. Sizing this constant with a comment claiming there is
// enough headroom would have manufactured the next instance of the same defect,
// so the arithmetic is asserted here instead.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import { tagAc } from "@memex-ai-ac/vitest";
import {
  RESPONSE_BODY_BUDGET_CHARS,
  MEASURED_ENVELOPE_MAX_CHARS,
  MEASURED_CAP_BOUND_CHARS,
  LARGEST_WORKING_BODY_CHARS,
  allocateResponseBudget,
} from "./response-budget.js";
import { formatFullDocState } from "./formatters.js";
import type { Doc, DocSection } from "../db/schema.js";

const AC = (n: number) =>
  `mindset-prod/memex-building-itself/specs/spec-538/acs/ac-${n}`;

/**
 * How much of the cap must stay unspent. The cap bound is the smallest refusal
 * ever OBSERVED, not the cap — the real value is lower, belongs to the client,
 * and is user-configurable. Characters are also a proxy for tokens, and the
 * ratio moves with content.
 */
const REQUIRED_CAP_MARGIN = 5_000;

/** How much room the body budget must leave above the largest working read. */
const REQUIRED_FLOOR_MARGIN = 2_000;

describe("the headroom is asserted, not claimed (ac-27)", () => {
  it("body budget + worst-case envelope stays under the measured cap bound", () => {
    tagAc(AC(27));
    const worstCaseResponse =
      RESPONSE_BODY_BUDGET_CHARS + MEASURED_ENVELOPE_MAX_CHARS;

    expect(worstCaseResponse).toBeLessThanOrEqual(
      MEASURED_CAP_BOUND_CHARS - REQUIRED_CAP_MARGIN,
    );
  });

  it("the envelope is accounted for by the constant, so the body render passes zero honestly (ac-18)", () => {
    tagAc(AC(18));
    // dec-7 option (d): the body is rendered before the envelope exists, so the
    // render cannot measure it. It does not have to — the budget it spends is
    // already net of the worst case, which is what the assertion above pins.
    // What must NOT be true is that the two are simply added and hoped about.
    const a = allocateResponseBudget({
      signalsChars: 0,
      envelopeChars: 0,
      proseChars: RESPONSE_BODY_BUDGET_CHARS - 1_000,
      decisionsFullChars: 500_000,
      decisionCount: 10,
    });
    const bodySpend =
      RESPONSE_BODY_BUDGET_CHARS - 1_000 + a.perDecisionChars * 10;
    expect(bodySpend + MEASURED_ENVELOPE_MAX_CHARS).toBeLessThan(
      MEASURED_CAP_BOUND_CHARS,
    );
  });
});

describe("no read that works today changes shape (ac-26)", () => {
  it("the body budget sits above the largest body observed to arrive intact", () => {
    tagAc(AC(26));
    // Measured across 18 reads that the client accepted: the largest body was
    // 33,501. At or below that, a response that works fine now would start being
    // excerpted — which is the regression ac-26 forbids.
    expect(RESPONSE_BODY_BUDGET_CHARS).toBeGreaterThanOrEqual(
      LARGEST_WORKING_BODY_CHARS + REQUIRED_FLOOR_MARGIN,
    );
  });

  it("a body the size of the largest working read still renders at tier 1", () => {
    tagAc(AC(26));
    const a = allocateResponseBudget({
      signalsChars: 0,
      envelopeChars: 0,
      proseChars: LARGEST_WORKING_BODY_CHARS,
      decisionsFullChars: 0,
      decisionCount: 0,
    });
    expect(a.tier).toBe(1);
    expect(a.renderProseBodies).toBe(true);
  });

  it("the two bounds leave a real window, not a knife edge", () => {
    tagAc(AC(26));
    const floor = LARGEST_WORKING_BODY_CHARS + REQUIRED_FLOOR_MARGIN;
    const ceiling =
      MEASURED_CAP_BOUND_CHARS - MEASURED_ENVELOPE_MAX_CHARS - REQUIRED_CAP_MARGIN;
    expect(ceiling).toBeGreaterThan(floor);
    expect(RESPONSE_BODY_BUDGET_CHARS).toBeGreaterThanOrEqual(floor);
    expect(RESPONSE_BODY_BUDGET_CHARS).toBeLessThanOrEqual(ceiling);
  });
});

describe("the name says BODY, so nobody budgets a whole response against it (ac-28)", () => {
  it("the exported identifier cannot be mistaken for a whole-response budget", () => {
    tagAc(AC(28));
    const src = readFileSync(
      fileURLToPath(new URL("./response-budget.ts", import.meta.url)),
      "utf8",
    );
    expect(src).toContain("export const RESPONSE_BODY_BUDGET_CHARS");
    // The old name must be gone everywhere, not shadowed by an alias.
    expect(src).not.toMatch(/export const RESPONSE_BUDGET_CHARS\b/);
    // And the file must say, in words, which half it bounds.
    expect(src).toMatch(/bounds the response\s*\n\/\/ BODY|budget bounds the response BODY|response\s+BODY/i);
  });

  it("the envelope parameter is not a field that is always zero and therefore meaningless", () => {
    tagAc(AC(28));
    // A caller that knows its envelope may tighten with it. Prove it still bites,
    // so the parameter is a real control rather than decoration.
    const without = allocateResponseBudget({
      signalsChars: 0,
      envelopeChars: 0,
      proseChars: 1_000,
      decisionsFullChars: 500_000,
      decisionCount: 10,
    });
    const with_ = allocateResponseBudget({
      signalsChars: 0,
      envelopeChars: 20_000,
      proseChars: 1_000,
      decisionsFullChars: 500_000,
      decisionCount: 10,
    });
    expect(with_.perDecisionChars).toBeLessThan(without.perDecisionChars);
  });
});

describe("the bound is held by a check on the real path (ac-4, ac-1)", () => {
  const baseDate = new Date("2026-03-25T12:00:00Z");

  function renderSpecOfProse(chars: number): string {
    const doc = {
      id: "d1",
      memexId: "m1",
      handle: "spec-1",
      title: "Representative",
      docType: "spec",
      status: "build",
      createdAt: baseDate,
      statusChangedAt: baseDate,
      version: 1,
      sensitive: false,
      sensitiveByName: null,
      checkedOutBy: null,
      checkedOutAt: null,
      sections: [
        {
          id: "s1",
          docId: "d1",
          sectionType: "overview",
          title: "Overview",
          content: "P".repeat(chars),
          seq: 1,
          position: 1,
          status: "active",
          createdAt: baseDate,
          updatedAt: baseDate,
        } as unknown as DocSection,
      ],
    } as unknown as Doc & { sections: DocSection[] };
    return formatFullDocState(doc, [], []);
  }

  it("the largest Spec shape measured in the wild arrives whole, under the budget (ac-1)", () => {
    tagAc(AC(1));
    // spec-472: 85,580 chars of prose, larger than the entire cap on its own.
    const out = renderSpecOfProse(85_580);
    expect(out.length).toBeLessThanOrEqual(RESPONSE_BODY_BUDGET_CHARS);
  });

  it("the check bites: inflate a fixture past the budget and the bound still holds", () => {
    tagAc(AC(4));
    // Ten times the worst Spec ever measured. If the ladder ever stopped
    // applying, this is the assertion that goes red rather than someone noticing
    // a spill in a session.
    for (const size of [50_000, 200_000, 900_000]) {
      const out = renderSpecOfProse(size);
      expect(
        out.length,
        `a ${size}-char Spec rendered ${out.length} chars`,
      ).toBeLessThanOrEqual(RESPONSE_BODY_BUDGET_CHARS);
    }
  });
});
