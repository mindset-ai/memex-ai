// spec-230 t-2 (ac-8): the creation system prompt must no longer cap the
// in-app flow at an Overview. It instructs INPUT-DRIVEN authoring — a
// substantial pasted document fleshes out into a rich, multi-section Spec the
// way the Memex MCP coding agent would, while a vague idea stays light — and it
// keeps the spec-5 Issue-4 guardrail (never silently over-scaffold empty stub
// sections). This pins that the Overview-only decree (and the "modal closes /
// do not offer more sections" dead-end) is gone and the parity instruction is
// present, in BOTH the role prompt (phases/creation/system.md) and the
// spec-document skill.

import { describe, it, expect } from "vitest";
import { tagAc } from "@memex-ai-ac/vitest";
import { buildCreationSystemBlocks } from "./system-prompt.js";
import { loadSkill } from "./skills.js";

const AC_CREATION_PROMPT_PARITY =
  "mindset-prod/memex-building-itself/specs/spec-230/acs/ac-8";

const role = () => buildCreationSystemBlocks()[0].text;

describe("creation prompt — Overview-only decree removed (spec-230 t-2)", () => {
  it("the role prompt no longer carries the Overview-only / dead-end directives", () => {
    tagAc(AC_CREATION_PROMPT_PARITY);
    const text = role();
    // The imperative decree must be gone. (The phrase "Overview-only" may still
    // appear once, naming the *superseded* cap — that's the supersession note,
    // not the rule — so we assert the directives, not the bare word.)
    expect(text).not.toMatch(/create only the Overview/i);
    expect(text).not.toMatch(/must NOT silently scaffold/i);
    expect(text).not.toMatch(/this modal closes once the Spec is created/i);
    expect(text).not.toMatch(/Do NOT offer to add more sections/i);
    expect(text).not.toMatch(/Do NOT add any further sections from this modal/i);
    // If "Overview-only" survives at all, it must be flagged as superseded.
    if (/Overview-only/i.test(text)) {
      expect(text).toMatch(/supersed[e|es|ed].{0,40}Overview-only|Overview-only cap/i);
    }
  });

  it("the role prompt instructs input-driven fleshing-out (substantial doc -> rich; vague -> light)", () => {
    tagAc(AC_CREATION_PROMPT_PARITY);
    const text = role();
    // Parity framing present.
    expect(text).toMatch(/parity/i);
    // The richness-tracks-input rule, both directions.
    expect(text).toMatch(/substantial (pasted )?document/i);
    expect(text).toMatch(/rich, multi-section Spec/i);
    expect(text).toMatch(/vague idea|keep it light|stays? (a )?light/i);
    // The agent is told to author beyond create_doc.
    expect(text).toMatch(/add_section/);
    expect(text).toMatch(/create_decision/);
    expect(text).toMatch(/create_ac/);
  });

  it("the role prompt keeps the spec-5 Issue-4 guardrail (no silent over-scaffolding)", () => {
    tagAc(AC_CREATION_PROMPT_PARITY);
    const text = role();
    expect(text).toMatch(/over-scaffold|stub sections|don't pad|do not pad/i);
    expect(text).toMatch(/Issue.?4/i);
  });

  it("the spec-document skill teaches input-driven authoring, not Overview-only-by-consent", () => {
    tagAc(AC_CREATION_PROMPT_PARITY);
    const skill = loadSkill("spec-document");
    // Old consent-gated phrasing is gone.
    expect(skill).not.toMatch(/do not auto-add body sections during creation/i);
    expect(skill).not.toMatch(/don't add the spine without consent/i);
    // New input-driven phrasing present, guardrail retained.
    expect(skill).toMatch(/content, not consent/i);
    expect(skill).toMatch(/never (add )?(empty )?(or premature )?stub/i);
  });
});
