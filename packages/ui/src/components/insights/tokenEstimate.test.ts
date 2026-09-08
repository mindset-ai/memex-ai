// spec-552 t-4 (dec-5), ac-12 — the divisor is one measured constant.
//
// Two properties are worth a test and one is not. The measured VALUE cannot be
// asserted here without re-running count_tokens on every suite run, which is
// exactly what pinning a constant avoids — so its provenance lives in the
// module's comment and on the Spec's task, and these tests assert the two things
// that can silently rot: that the constant stays plausible, and that it stays
// the ONLY conversion.

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { tagAc } from "@memex-ai-ac/vitest";
import { CHARS_PER_TOKEN, estimateTokens } from "./tokenEstimate";

const AC = (n: number) =>
  `mindset-prod/memex-building-itself/specs/spec-552/acs/ac-${n}`;

const here = dirname(fileURLToPath(import.meta.url));

describe("the chars-to-tokens divisor (spec-552 ac-12)", () => {
  it("sits inside the measured spread, so a stray edit cannot pass unnoticed", () => {
    tagAc(AC(12));
    // Measured 2026-09-08 on 148 real payloads: aggregate 2.730, per-payload
    // p10/p90 2.175/3.043. A value outside that band is not a re-measurement,
    // it is a guess — and the most likely wrong values are exactly the round
    // ones somebody would reach for (3.0, 4.0) or the stale 2.38.
    expect(CHARS_PER_TOKEN).toBeGreaterThan(2.17);
    expect(CHARS_PER_TOKEN).toBeLessThan(3.05);
    expect(CHARS_PER_TOKEN).toBe(2.73);
  });

  it("carries its provenance in the source, not in a commit message", () => {
    tagAc(AC(12));
    // ac-12 requires the constant to have a provenance a reader can check.
    // A comment is the only place that travels with the value.
    const src = readFileSync(join(here, "tokenEstimate.ts"), "utf8");
    expect(src).toContain("count_tokens");
    expect(src).toContain("claude-opus-5");
    expect(src).toContain("2026-09-08");
    expect(src).toMatch(/841,280 characters/);
    expect(src).toMatch(/RE-MEASURE WHEN/);
  });

  it("is the only conversion — no second divisor hides in the insights folder", () => {
    tagAc(AC(12));
    // The failure this guards: someone needs a token figure in a new chart,
    // does not find this module, and writes `chars / 3` inline. Two divisors
    // then disagree on the same page and nothing fails.
    //
    // Comments are stripped first: this module's own prose discusses 3.0, 2.38
    // and the band edges, and a naive scan would match its own documentation.
    // (Both source guards written earlier today tripped on exactly that.)
    // PRODUCTION files only. A test file legitimately quotes divisor SHAPES —
    // CostPanelCard.test.tsx carries the very regex that hunts for them — and
    // flagging those is a false positive that trains people to disable the
    // guard. What must stay clean is the code that ships.
    const files = readdirSync(here).filter(
      (f) =>
        (f.endsWith(".ts") || f.endsWith(".tsx")) &&
        !f.includes(".test.") &&
        !f.includes(".spec.")
    );
    const offenders: string[] = [];
    for (const file of files) {
      if (file.startsWith("tokenEstimate")) continue;
      const code = readFileSync(join(here, file), "utf8")
        .split("\n")
        .filter((line) => !line.trimStart().startsWith("//"))
        .join("\n")
        .replace(/\/\*[\s\S]*?\*\//g, "");
      // A division by a small decimal or by 3/4 — the shapes a hand-rolled
      // chars-per-token conversion takes.
      if (/\/\s*(?:2\.\d+|3\.\d+|3|4)\b\s*\)?\s*[;,)]/.test(code)) {
        offenders.push(file);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("rounds to whole tokens and refuses nonsense input", () => {
    tagAc(AC(12));
    expect(estimateTokens(2730)).toBe(1000);
    expect(estimateTokens(273)).toBe(100);
    // Sub-token inputs round down to 0. That is honest for a display estimate —
    // claiming "1 token" for a single character would be inventing precision the
    // divisor does not have — and no real payload is one character anyway.
    expect(estimateTokens(1)).toBe(0);
    expect(estimateTokens(2)).toBe(1);
    // Absent / impossible values must not render as NaN on the card.
    expect(estimateTokens(0)).toBe(0);
    expect(estimateTokens(-5)).toBe(0);
    expect(estimateTokens(Number.NaN)).toBe(0);
    expect(estimateTokens(Number.POSITIVE_INFINITY)).toBe(0);
  });

  it("is monotonic, so a bigger payload never reads as fewer tokens", () => {
    tagAc(AC(12));
    let previous = -1;
    for (const chars of [0, 1, 10, 100, 1_000, 10_000, 100_000, 1_000_000]) {
      const tokens = estimateTokens(chars);
      expect(tokens).toBeGreaterThanOrEqual(previous);
      previous = tokens;
    }
  });
});
