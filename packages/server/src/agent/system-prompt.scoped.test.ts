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
// spec-300 t-15 (dec-23): ac-51 — the skills-agent mode prompt block is injected
// only when mode === 'skills', and appends the shared handoff map (std-38).
const AC_SKILLS_BLOCK =
  "mindset-prod/memex-building-itself/specs/spec-300/acs/ac-51";

function instructionText(scopedMode?: "standards" | "issues" | "skills"): string {
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

  it("spec-300 ac-51: skills mode injects the skills-agent block + the shared handoff map, only when mode is skills", () => {
    tagAc(AC_SKILLS_BLOCK);
    const text = instructionText("skills");
    // The dedicated skills-agent MODE block (distinct from the awareness block
    // "## Skills — reusable procedures you can follow" every agent carries).
    expect(text).toContain("## Skills agent");
    expect(text).toContain("update_skill"); // its one verbed authoring/curation path
    expect(text).toContain("hand off"); // the shared cross-agent handoff map rides along
    // Not the sibling scoped blocks.
    expect(text).not.toContain("## Standards agent");
    expect(text).not.toContain("## Issues agent");
    // And an unscoped (spec) build does NOT carry the dedicated skills-agent block.
    expect(instructionText(undefined)).not.toContain("## Skills agent");
  });
});
