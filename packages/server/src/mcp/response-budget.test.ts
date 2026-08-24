import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import { tagAc } from "@memex-ai-ac/vitest";
import {
  RESPONSE_BUDGET_CHARS,
  MIN_EXCERPT_CHARS,
  allocateResponseBudget,
  effectiveBudget,
} from "./response-budget.js";

const AC = (n: number) =>
  `mindset-prod/memex-building-itself/specs/spec-538/acs/ac-${n}`;

/** A doc that comfortably fits, as a base to vary one dimension at a time. */
const SMALL = {
  signalsChars: 500,
  envelopeChars: 3_000,
  proseChars: 5_000,
  decisionsFullChars: 4_000,
  decisionCount: 4,
};

describe("allocateResponseBudget — the total is configured, the per-decision length is derived (ac-7)", () => {
  it("holds the document total flat while the decision count changes the excerpt length", () => {
    tagAc(AC(7));
    // Same Spec, same prose, same total decision weight — only the count moves.
    const decisionsFullChars = 60_000;
    const seven = allocateResponseBudget({
      ...SMALL,
      proseChars: 20_000,
      decisionsFullChars,
      decisionCount: 7,
    });
    const thirty = allocateResponseBudget({
      ...SMALL,
      proseChars: 20_000,
      decisionsFullChars,
      decisionCount: 30,
    });

    // Both are bounded by the SAME total…
    expect(seven.budget).toBe(RESPONSE_BUDGET_CHARS);
    expect(thirty.budget).toBe(RESPONSE_BUDGET_CHARS);

    // …and the count is absorbed by the excerpt length, not by the total.
    expect(thirty.perDecisionChars).toBeLessThan(seven.perDecisionChars);

    // The whole point: what each renders stays inside the budget.
    for (const a of [seven, thirty]) {
      const spent =
        SMALL.signalsChars +
        SMALL.envelopeChars +
        20_000 +
        a.perDecisionChars * (a === seven ? 7 : 30);
      expect(spent).toBeLessThanOrEqual(a.budget);
    }
  });

  it("is a bound by construction: no decision count makes the spend exceed the budget", () => {
    tagAc(AC(7));
    // The failure mode a PER-DECISION constant would reintroduce. 800 chars ×
    // 30 decisions is 24k of excerpts alone; deriving downward cannot do that.
    for (const decisionCount of [1, 7, 30, 200, 5_000]) {
      const a = allocateResponseBudget({
        ...SMALL,
        proseChars: 20_000,
        decisionsFullChars: 500_000,
        decisionCount,
      });
      const spent =
        SMALL.signalsChars +
        SMALL.envelopeChars +
        20_000 +
        a.perDecisionChars * decisionCount;
      expect(spent).toBeLessThanOrEqual(a.budget);
    }
  });

  it("falls to headline + ref rather than emit an excerpt too short to act on", () => {
    tagAc(AC(7));
    const a = allocateResponseBudget({
      ...SMALL,
      proseChars: 20_000,
      decisionsFullChars: 500_000,
      decisionCount: 5_000, // derived length would be a handful of characters
    });
    expect(a.tier).toBe(2);
    expect(a.perDecisionChars).toBe(0);
    // …while a roomier Spec still gets a real excerpt.
    const roomy = allocateResponseBudget({
      ...SMALL,
      proseChars: 20_000,
      decisionsFullChars: 500_000,
      decisionCount: 7,
    });
    expect(roomy.perDecisionChars).toBeGreaterThanOrEqual(MIN_EXCERPT_CHARS);
  });

  it("leaves a fitting document untouched — tier 1 does not reshape the common case", () => {
    tagAc(AC(7));
    const a = allocateResponseBudget(SMALL);
    expect(a.tier).toBe(1);
    expect(a.renderProseBodies).toBe(true);
    expect(a.perDecisionChars).toBe(Number.POSITIVE_INFINITY);
  });
});

describe("allocateResponseBudget — signals come off the top and are never rationed (ac-9)", () => {
  it("subtracts signals and the envelope before anything negotiable", () => {
    tagAc(AC(9));
    const a = allocateResponseBudget({ ...SMALL, signalsChars: 1_200 });
    expect(a.remainingAfterFixed).toBe(
      RESPONSE_BUDGET_CHARS - 1_200 - SMALL.envelopeChars,
    );
  });

  it("degrades the tier rather than the signals when the budget is exhausted", () => {
    tagAc(AC(9));
    // Engineered so prose alone blows the budget — spec-472's real shape.
    const a = allocateResponseBudget({
      ...SMALL,
      proseChars: 85_580,
      decisionsFullChars: 60_000,
      decisionCount: 7,
    });
    // Content is what gives way…
    expect(a.tier).toBe(3);
    expect(a.renderProseBodies).toBe(false);
    expect(a.perDecisionChars).toBe(0);
    // …and the signals' allowance was never reduced to buy room: what is left
    // after the fixed costs is exactly budget − signals − envelope, whatever
    // the content does.
    expect(a.remainingAfterFixed).toBe(
      RESPONSE_BUDGET_CHARS - SMALL.signalsChars - SMALL.envelopeChars,
    );
  });

  it("reports an honest negative when the fixed costs alone overflow", () => {
    tagAc(AC(9));
    // Not reachable today, but it must not silently read as 'plenty of room'.
    const a = allocateResponseBudget({
      ...SMALL,
      signalsChars: 30_000,
      envelopeChars: 30_000,
    });
    expect(a.remainingAfterFixed).toBeLessThan(0);
    expect(a.tier).toBe(3);
  });
});

describe("the budget is one constant, from one place (ac-10)", () => {
  it("never reads an environment variable — the cap belongs to the client, not the deployment", () => {
    tagAc(AC(10));
    const src = readFileSync(
      fileURLToPath(new URL("./response-budget.ts", import.meta.url)),
      "utf8",
    );
    // Strip comments: the prose explains WHY there is no env var, and must not
    // trip the scan that proves it.
    const code = src
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    expect(code).not.toMatch(/process\.env/);
    expect(code).not.toMatch(/import\.meta\.env/);
  });

  it("falls back to the constant for an omitted or unusable override, never to unbounded output", () => {
    tagAc(AC(10));
    for (const bad of [
      undefined,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      0,
      -1,
      -50_000,
    ]) {
      expect(effectiveBudget(bad as number | undefined)).toBe(
        RESPONSE_BUDGET_CHARS,
      );
    }
  });

  it("lets a per-call override tighten the bound but never widen it", () => {
    tagAc(AC(10));
    // Only the client knows its own cap, so a smaller one is honoured…
    expect(effectiveBudget(10_000)).toBe(10_000);
    // …but an override cannot be used to escape the ceiling.
    expect(effectiveBudget(RESPONSE_BUDGET_CHARS * 10)).toBe(
      RESPONSE_BUDGET_CHARS,
    );
  });
});
