// spec-143 t-4 (dec-6) — the drift-mode prompt overlay.
//
// buildSystemBlocks appends DRIFT_AGENT_GUIDANCE only when driftMode=true, AFTER
// the phase blocks + phase guidance, so the drift posture composes on top of the
// agent's general orientation. Pure assertions on the assembled prompt text — no
// DB, no LLM. The prose is single-sourced from @memex/shared (std-15).

import { describe, it, expect } from "vitest";
import { DRIFT_AGENT_GUIDANCE } from "@memex/shared";
import { tagAc } from "@memex-ai-ac/vitest";
import { buildSystemBlocks } from "./system-prompt.js";

const AC_DRIFT_MODE =
  "mindset-prod/memex-building-itself/specs/spec-143/acs/ac-12";
// ac-13 (implementation, dec-6): the posture-overlay half of the drift-mode
// mechanism — DRIFT_BLOCK composed by buildSystemBlocks({driftMode:true}).
const AC_DRIFT_MECHANISM =
  "mindset-prod/memex-building-itself/specs/spec-143/acs/ac-13";

const CTX = "## Document Context\nOpen drift: 2 items across 1 standard.";
const DRIFT_MARKER = DRIFT_AGENT_GUIDANCE.text.slice(0, 40);

function instructionText(driftMode: boolean): string {
  // (documentContext, phase, readOnly, reviewer, driftMode)
  const blocks = buildSystemBlocks(CTX, "plan", false, false, driftMode);
  return blocks[0]!.text;
}

describe("spec-143 drift-mode prompt overlay", () => {
  it("appends the single-sourced DRIFT block only in drift mode; the default agent never sees it", () => {
    tagAc(AC_DRIFT_MODE);
    tagAc(AC_DRIFT_MECHANISM);
    const driftPrompt = instructionText(true);
    const defaultPrompt = instructionText(false);

    expect(driftPrompt).toContain(DRIFT_MARKER);
    expect(defaultPrompt).not.toContain(DRIFT_MARKER);

    // The prose is the scaffold node verbatim (single source, std-15) — not inlined.
    expect(driftPrompt).toContain(DRIFT_AGENT_GUIDANCE.text);
  });

  it("composes the drift block ON TOP of the general orientation (phase blocks still present)", () => {
    tagAc(AC_DRIFT_MODE);
    const driftPrompt = instructionText(true);
    // The agent keeps its general Memex posture: the context-awareness block's
    // signature instruction is still there alongside the drift overlay.
    expect(driftPrompt).toContain("Never");
    expect(driftPrompt).toContain(DRIFT_AGENT_GUIDANCE.text);
  });
});
