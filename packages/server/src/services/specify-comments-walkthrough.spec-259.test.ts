// spec-259 t-3 — ac-3: the specify-phase prompt instructs the agent to walk the
// user through open comments BEFORE advancing specify→build.
//
// The specify-phase prompt prose is the `phase-specify-intent` PromptBlock in
// `@memex/shared`'s scaffold-data.ts (the single owner of phase prompt prose
// per std-15 / b-68 dec-6). We assert against the SOURCE file so the test is
// robust to the @memex/shared dist rebuild timing — it must hold the
// walkthrough instruction in the existing freshness-walkthrough voice.

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import { tagAc } from "@memex-ai-ac/vitest";

const AC = (n: number) =>
  `mindset-prod/memex-building-itself/specs/spec-259/acs/ac-${n}`;

const here = dirname(fileURLToPath(import.meta.url));
const SCAFFOLD_DATA = resolve(
  here,
  "..",
  "..",
  "..",
  "shared",
  "src",
  "scaffold-data.ts",
);

describe("spec-259: specify prompt instructs the open-comment walkthrough (ac-3)", () => {
  it("the specify-phase intent block tells the agent to walk open comments before specify→build", () => {
    tagAc(AC(3));
    const src = readFileSync(SCAFFOLD_DATA, "utf8");

    // The instruction lives in the phase-specify-intent block.
    const intentIdx = src.indexOf("id: 'phase-specify-intent'");
    expect(intentIdx).toBeGreaterThan(-1);
    // Bound the assertion to that block (up to the next prompt-block id).
    const after = src.slice(intentIdx);
    const block = after.slice(0, after.indexOf("id: 'phase-specify-discipline'"));

    expect(block).toMatch(/before advancing specify.+build/i);
    expect(block).toMatch(/walk the user through .*open comments/i);
    // Mirrors the assess_spec comments survey it should lean on. (Source escapes
    // the inner single quotes, so match on the tool + mode tokens.)
    expect(block).toContain("assess_spec");
    expect(block).toMatch(/mode:.{0,2}comments/);
    // States plainly that open comments do not gate the transition.
    expect(block).toMatch(/do not block|not blocked/i);
  });
});
