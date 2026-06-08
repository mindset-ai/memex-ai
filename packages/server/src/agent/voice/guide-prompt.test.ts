// spec-206 t-4 — the demo walkthrough beats in the guide's system prompt.
//
// ac-4 — the five phases are present, in lifecycle order, for narration.
// ac-6 / ac-9 — the narration text is single-sourced from the spec-178 fixture
//   (HANDHOLD_PHASES[].valueCallout) and lives in the system PROMPT, so the guide
//   narrates from context — never via a doc-lookup tool (the demo specs are
//   invisible to every agent surface, spec-178 dec-11).

import { describe, it, expect } from "vitest";
import { tagAc } from "@memex-ai-ac/vitest";
import { buildGuideSystemBlocks } from "./guide-prompt.js";
import { HANDHOLD_PHASES } from "../../db/handhold-demo.fixture.js";

const AC = (n: number) =>
  `mindset-prod/memex-building-itself/specs/spec-206/acs/ac-${n}`;

const blocks = buildGuideSystemBlocks({
  screenKey: "specs-list",
  screenRegistry: [],
  guideContext: [],
});
const text = blocks.map((b) => b.text).join("\n");

describe("guide system prompt — demo walkthrough beats (spec-206 t-4)", () => {
  it("includes every phase beat verbatim, single-sourced from the spec-178 fixture (ac-6 / ac-9)", () => {
    // Each beat is the fixture's own valueCallout — re-typing it here would drift,
    // so this proves the prompt is built FROM the fixture, not a copy.
    for (const p of HANDHOLD_PHASES) {
      expect(text).toContain(p.valueCallout);
    }
    tagAc(AC(6));
    tagAc(AC(9));
  });

  it("lists all five phases in lifecycle order for narration (ac-4)", () => {
    // Scope to the beats BLOCK — the instruction prose also names the phases
    // ("draft → specify → … → done"), which would fool an indexOf over all text.
    const beatsBlock = blocks.find((b) => b.text.startsWith("## Demo walkthrough beats"));
    expect(beatsBlock).toBeDefined();
    const beats = beatsBlock!.text;
    const order = ["draft", "specify", "build", "verify", "done"];
    const positions = order.map((ph) => beats.indexOf(`**${ph}**`));
    // Every phase present...
    expect(positions.every((i) => i >= 0)).toBe(true);
    // ...and in strictly ascending order (draft → specify → build → verify → done).
    const ascending = [...positions].sort((a, b) => a - b);
    expect(positions).toEqual(ascending);
    tagAc(AC(4));
  });

  it("instructs the guide to hand the walkthrough to the app, not self-advance (spec-211 ac-15 / ac-6)", () => {
    const lower = text.toLowerCase();
    // The guide hands off via start_walkthrough...
    expect(text).toContain("start_walkthrough");
    // ...and is explicitly told NOT to drive the board itself.
    expect(lower).toContain("do not advance the board yourself");
    expect(lower).toContain("never call `advance_demo`");
    // The OLD burst instruction is gone.
    expect(text).not.toContain("After you finish narrating each phase, call `advance_demo`");
    expect(text).not.toContain("Narrate these five phases in order when the user accepts");
    // The beats are still single-sourced from the fixture (ac-6).
    for (const p of HANDHOLD_PHASES) expect(text).toContain(p.valueCallout);
    tagAc(AC(15));
    tagAc(AC(6));
  });
});
