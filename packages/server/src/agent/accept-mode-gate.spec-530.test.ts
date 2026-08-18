// spec-530 t-4 (dec-4, ac-13) — the apply verb is reachable from exactly the two agents
// that handle Standards, and REFUSED everywhere else.
//
// std-38 is explicit that authoring scope is enforced server-side, not by prompt: the
// `/tools/execute` route consults `isToolAllowedInMode` before running anything, so a
// scoped mode that does not own a verb is refused there — not merely denied the tool
// definition. Hiding a tool from the model is a hint; the gate is the enforcement.
//
// This matters more for this verb than for most: it is the one call that rewrites a
// Standard's rule text and closes the proposal in the same breath.

import { describe, it, expect } from "vitest";
import { tagAc } from "@memex-ai-ac/vitest";
import { getToolDefinitions, isToolAllowedInMode, type AgentMode } from "./tools.js";

const AC_13 = "mindset-prod/memex-building-itself/specs/spec-530/acs/ac-13";

const VERB = "accept_standard_change";

/** Every scoped mode that must NOT be able to accept a Standard change. */
const FOREIGN_MODES: Exclude<AgentMode, "spec">[] = ["scaffold", "issues", "skills"];

describe("spec-530 ac-13: accept_standard_change is scoped to the Standards agents", () => {
  it("is offered to the drift and standards modes", () => {
    tagAc(AC_13);
    for (const mode of ["drift", "standards"] as const) {
      const names = getToolDefinitions({ mode }).map((t) => t.name);
      expect(names, `${mode} mode should offer ${VERB}`).toContain(VERB);
    }
  });

  it("is REFUSED by the gate predicate for every other scoped mode, not just hidden", () => {
    tagAc(AC_13);
    for (const mode of FOREIGN_MODES) {
      // The definition filter — what the model can see.
      expect(getToolDefinitions({ mode }).map((t) => t.name), `${mode} definitions`).not.toContain(
        VERB,
      );
      // The authoritative gate — what /tools/execute will actually run. A model that
      // learned the name from anywhere else (a cached surface, a pasted transcript)
      // still cannot execute it here [per std-38].
      expect(isToolAllowedInMode(mode, VERB), `${mode} gate`).toBe(false);
    }
  });

  it("permits it in the two owning modes at the gate", () => {
    tagAc(AC_13);
    expect(isToolAllowedInMode("drift", VERB)).toBe(true);
    expect(isToolAllowedInMode("standards", VERB)).toBe(true);
  });

  it("is available on the unrestricted spec surface, like every other server tool", () => {
    tagAc(AC_13);
    // `spec` (and an absent mode) is governed by phase / reviewer gates rather than a
    // mode subset — asserted so a later reader does not mistake its presence there for
    // a leak in the scoped-mode wall.
    expect(isToolAllowedInMode("spec", VERB)).toBe(true);
    expect(isToolAllowedInMode(undefined, VERB)).toBe(true);
  });
});
