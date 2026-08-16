// spec-530 t-8 (ac-5) — the drift agent's guidance describes the surface that
// actually exists, and names an apply path the tools actually accept.
//
// Two defects, both observed in one session with a real user:
//   1. It instructed `update_section` to apply an accepted proposal. That call has
//      thrown on every Standard since spec-161 made them clause-backed
//      (agent/handlers/sections.ts: "Standards are edited at the clause grain").
//      The instruction had been wrong for months because nothing executes prose as
//      a contract.
//   2. Having no way to apply the change, the agent told the user to click an
//      "Accept" button in the Drift Inbox. No such control exists anywhere in the
//      UI — spec-143 dec-3 deliberately removed the per-row action buttons. The
//      prompt never described the surface, so the agent invented one.
//
// Asserted against the COMPOSED drift-mode prompt, not the raw constant: what
// matters is what the agent is actually handed [per std-34, the honest-CTA rule].

import { describe, it, expect } from "vitest";
import { tagAc } from "@memex-ai-ac/vitest";
import { buildSystemBlocks } from "./system-prompt.js";

const AC_5 = "mindset-prod/memex-building-itself/specs/spec-530/acs/ac-5";

// (documentContext, phase, readOnly, reviewer, driftMode, …)
function driftPrompt(): string {
  return buildSystemBlocks("", "specify", false, false, true)
    .map((b) => b.text)
    .join("\n\n");
}

function specPrompt(): string {
  return buildSystemBlocks("", "specify", false, false, false)
    .map((b) => b.text)
    .join("\n\n");
}

describe("spec-530 ac-5: the drift agent describes the real surface", () => {
  it("names the clause verbs as the apply path, not update_section", () => {
    tagAc(AC_5);
    const prompt = driftPrompt();

    // The verbs that actually work on a Standard.
    expect(prompt).toContain("edit_clause");
    expect(prompt).toContain("add_clause");
    expect(prompt).toContain("delete_clause");

    // And no surviving instruction to apply a proposal with update_section — the
    // exact sentence a user watched the agent try and fail on.
    expect(prompt).not.toMatch(/apply the proposed text to the Standard with `update_section`/);
    expect(prompt).not.toMatch(/edit the Standard text directly with `update_section`/);
  });

  it("states that update_section refuses on a Standard, so the agent stops reaching for it", () => {
    tagAc(AC_5);
    expect(driftPrompt()).toMatch(/`update_section` refuses on a Standard/);
  });

  it("tells the agent the Inbox has no action buttons (the hallucinated Accept)", () => {
    tagAc(AC_5);
    const prompt = driftPrompt();

    expect(prompt).toMatch(/no action buttons/i);
    // And says where acceptance DOES happen, so the correction is actionable
    // rather than just a prohibition.
    expect(prompt).toMatch(/in conversation/i);
  });

  it("carries none of this into the primary Spec agent — drift mode only", () => {
    tagAc(AC_5);
    // The drift block is a conditional overlay. If it leaked into the unscoped
    // agent, every Spec conversation would inherit Standards-specific rules.
    expect(specPrompt()).not.toMatch(/no action buttons/i);
  });
});
