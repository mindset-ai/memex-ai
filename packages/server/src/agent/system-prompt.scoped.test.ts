// spec-389 t-5 (dec-2): the standards / issues agent mode prompts. buildSystemBlocks
// appends each scoped mode's behaviour block + the shared cross-agent handoff map
// (spec-389 t-4) over the same phase-composed base — so the new agents lead with
// their own job and hand off for anything outside it (ac-4).

import { describe, it, expect } from "vitest";
import { tagAc } from "@memex-ai-ac/vitest";
import { buildSystemBlocks } from "./system-prompt.js";

// ac-4 (scope): the Standards + Issues surfaces each have a working agent scoped
// to its own function.
const AC_NEW_AGENTS =
  "mindset-prod/memex-building-itself/specs/spec-389/acs/ac-4";

function instructionText(scopedMode?: "standards" | "issues"): string {
  const blocks = buildSystemBlocks(
    "ctx",
    "specify",
    false,
    false,
    false,
    undefined,
    false,
    scopedMode,
  );
  // The first block is the assembled instruction text.
  return (blocks[0] as { text: string }).text;
}

describe("buildSystemBlocks — scoped standards/issues modes (ac-4)", () => {
  it("standards mode injects the standards block + the shared handoff map", () => {
    tagAc(AC_NEW_AGENTS);
    const text = instructionText("standards");
    expect(text).toContain("## Standards agent");
    expect(text).toContain("author"); // its authoring job
    // the shared cross-agent handoff contract rides along…
    expect(text).toContain("hand off");
    // …and NOT the issues block.
    expect(text).not.toContain("## Issues agent");
  });

  it("issues mode injects the issues block + the shared handoff map", () => {
    tagAc(AC_NEW_AGENTS);
    const text = instructionText("issues");
    expect(text).toContain("## Issues agent");
    expect(text).toContain("parking lot");
    expect(text).toContain("hand off");
    expect(text).not.toContain("## Standards agent");
  });

  it("an unscoped (spec) build injects neither scoped block", () => {
    tagAc(AC_NEW_AGENTS);
    const text = instructionText(undefined);
    expect(text).not.toContain("## Standards agent");
    expect(text).not.toContain("## Issues agent");
  });
});
