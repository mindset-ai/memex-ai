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
  RESPONSE_BUDGET_CHARS,
  MEASURED_ENVELOPE_MAX_CHARS,
  DECLARED_CLIENT_RESULT_CEILING_CHARS,
  CLIENT_DEFAULT_CEILING_CHARS,
  LARGEST_WORKING_BODY_CHARS,
  allocateResponseBudget,
} from "./response-budget.js";
import { formatFullDocState } from "./formatters.js";
import type { Doc, DocSection } from "../db/schema.js";

const AC = (n: number) =>
  `mindset-prod/memex-building-itself/specs/spec-538/acs/ac-${n}`;

/**
 * How much of the ceiling must stay unspent.
 *
 * t-12 changed what this is a margin UNDER. It used to guard
 * MEASURED_CAP_BOUND_CHARS — the smallest refusal ever observed, which turned out
 * to be 41.6% above the client's real default, so the margin was protecting a
 * number that was already too generous. It now guards the ceiling this server
 * DECLARES (dec-9), which is a value we state rather than infer.
 *
 * Still non-zero, and deliberately unchanged at 5,000: the declared ceiling is
 * ours, but a client may still hold a per-tool override, and the serialised form
 * the client weighs runs ~1.3% longer than the text we measure.
 */
const REQUIRED_CAP_MARGIN = 5_000;

/** How much room the body budget must leave above the largest working read. */
const REQUIRED_FLOOR_MARGIN = 2_000;

describe("the headroom is asserted, not claimed (ac-27)", () => {
  it("the declared ceiling, not the client's default, is what the headroom sits under", () => {
    tagAc(AC(27));
    // t-12: the original headroom was checked against a refusal sample (70,794)
    // that sat 41.6% above the client's real default (50,000) — so body 40,000 +
    // envelope 23,244 = 63,244 "cleared the cap" while actually exceeding it by
    // 13,244. The bound held by luck. It now sits under a ceiling this server
    // states, and the default is recorded so the gap is visible.
    expect(DECLARED_CLIENT_RESULT_CEILING_CHARS).toBeGreaterThan(
      CLIENT_DEFAULT_CEILING_CHARS,
    );
    expect(
      RESPONSE_BUDGET_CHARS + MEASURED_ENVELOPE_MAX_CHARS,
      "the worst case must NOT fit under the client's bare default — if it did, " +
        "the declaration would be doing nothing",
    ).toBeGreaterThan(CLIENT_DEFAULT_CEILING_CHARS);
  });

  it("one full budget, serialised, stays under the declared ceiling", () => {
    tagAc(AC(27));
    // t-15 INVERTED this. It used to assert `budget + envelope <= cap`, because
    // dec-7 option (d) made the budget body-only and left the envelope beyond it.
    // The envelope is now a fixed cost INSIDE the allocation, so adding it again
    // would double-count. What must fit is one full budget, weighed the way the
    // client weighs it — the JSON-serialised content array, ~1.3% longer than the
    // rendered text because newlines are escaped.
    const onTheWire = JSON.stringify(
      [{ type: "text", text: "P".repeat(RESPONSE_BUDGET_CHARS) }],
      null,
      2,
    ).length;

    expect(
      onTheWire,
      `a full ${RESPONSE_BUDGET_CHARS} budget serialises to ${onTheWire}`,
    ).toBeLessThanOrEqual(
      DECLARED_CLIENT_RESULT_CEILING_CHARS - REQUIRED_CAP_MARGIN,
    );

    // The envelope must be INSIDE the budget, not beyond it: adding the measured
    // worst case on top must overflow, or the allocator counting it would be
    // decorative and could quietly go back to zero.
    expect(
      RESPONSE_BUDGET_CHARS + MEASURED_ENVELOPE_MAX_CHARS,
      "if budget+envelope still fitted, counting the envelope would be optional",
    ).toBeGreaterThan(DECLARED_CLIENT_RESULT_CEILING_CHARS);
  });

  it("the envelope is counted INSIDE the budget, not added on top of it (ac-18)", () => {
    tagAc(AC(18));
    // t-15 made this criterion literally true, where dec-7 option (d) had only
    // made it true by construction. The old test asserted that the render "passes
    // zero honestly" because the constant was already net of the worst case —
    // a claim retired with dec-7's amendment.
    //
    // Now the envelope is a fixed cost the allocator subtracts before anything
    // negotiable, so the property to assert is that it BITES: the same document
    // gets measurably less room to spend when its envelope is larger.
    const withSmallEnvelope = allocateResponseBudget({
      signalsChars: 0,
      envelopeChars: 4_000,
      proseChars: 1_000,
      decisionsFullChars: 500_000,
      decisionCount: 10,
    });
    const withLargeEnvelope = allocateResponseBudget({
      signalsChars: 0,
      envelopeChars: 18_000,
      proseChars: 1_000,
      decisionsFullChars: 500_000,
      decisionCount: 10,
    });
    expect(withLargeEnvelope.perDecisionChars).toBeLessThan(
      withSmallEnvelope.perDecisionChars,
    );
    expect(withLargeEnvelope.remainingAfterFixed).toBe(
      withSmallEnvelope.remainingAfterFixed - 14_000,
    );

    // And the total a response can spend — content plus the envelope it is
    // emitted alongside — never exceeds the budget. That is the whole point of
    // counting it: the two are no longer "added and hoped about".
    const envelope = 18_000;
    const spent =
      envelope + 1_000 + withLargeEnvelope.perDecisionChars * 10;
    expect(spent).toBeLessThanOrEqual(withLargeEnvelope.budget);
  });
});

describe("no read that works today changes shape (ac-26)", () => {
  it("the body budget sits above the largest body observed to arrive intact", () => {
    tagAc(AC(26));
    // Measured across 18 reads that the client accepted: the largest body was
    // 33,501. At or below that, a response that works fine now would start being
    // excerpted — which is the regression ac-26 forbids.
    expect(RESPONSE_BUDGET_CHARS).toBeGreaterThanOrEqual(
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
    // t-15: the budget is inclusive, so the ceiling is no longer the declared
    // value less the envelope — the envelope is spent from inside it. What bounds
    // it is the declared ceiling less the margin, net of the serialisation
    // overhead the client weighs and we do not.
    const ceiling = Math.floor(
      (DECLARED_CLIENT_RESULT_CEILING_CHARS - REQUIRED_CAP_MARGIN) / 1.013,
    );
    expect(ceiling).toBeGreaterThan(floor);
    expect(RESPONSE_BUDGET_CHARS).toBeGreaterThanOrEqual(floor);
    expect(RESPONSE_BUDGET_CHARS).toBeLessThanOrEqual(ceiling);
  });
});

describe("the name matches what the number covers — the WHOLE response (ac-28)", () => {
  it("the exported identifier does not understate its scope", () => {
    tagAc(AC(28));
    // t-15 INVERTED this criterion, deliberately.
    //
    // Under dec-7 option (d) the budget was body-only, so `RESPONSE_BODY_BUDGET_CHARS`
    // was the honest name and this test forbade the shorter one. The envelope is
    // now a fixed cost inside the allocation, so a name saying BODY would
    // understate what the number bounds — the same trap dec-7 warned about,
    // pointing the other way.
    const src = readFileSync(
      fileURLToPath(new URL("./response-budget.ts", import.meta.url)),
      "utf8",
    );
    expect(src).toContain("export const RESPONSE_BUDGET_CHARS");
    // The body-only name must be gone everywhere, not shadowed by an alias.
    expect(src).not.toMatch(/export const RESPONSE_BODY_BUDGET_CHARS\b/);
    // And the file must say, in words, that it bounds the whole response.
    expect(src).toMatch(/bounds the WHOLE response/);
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
    expect(out.length).toBeLessThanOrEqual(RESPONSE_BUDGET_CHARS);
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
      ).toBeLessThanOrEqual(RESPONSE_BUDGET_CHARS);
    }
  });
});
