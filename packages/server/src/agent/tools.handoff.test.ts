// spec-389 t-4 (dec-3): the shared render_handoff tool — when asked outside its
// function, an agent refuses and emits a copyable handoff prompt instead of
// reaching for a tool it shouldn't have. These tests pin that render_handoff is
// a display-only UI tool present in EVERY mode, with the documented schema.

import { describe, it, expect } from "vitest";
import { tagAc } from "@memex-ai-ac/vitest";
import { getToolDefinitions, isUiTool } from "./tools.js";
import type { AgentMode } from "./tools.js";

// ac-11 (implementation, dec-3): one shared render_handoff used by all agents;
// an out-of-function request resolves through the canonical map to the right
// target agent.
const AC_HANDOFF =
  "mindset-prod/memex-building-itself/specs/spec-389/acs/ac-11";
// spec-300 t-15 (dec-23): ac-48 — for a request outside skill authoring the skills
// agent declines honestly and hands off with a copyable render_handoff, rather than
// reaching for a tool it should not have. render_handoff riding into skills mode
// (and update_skill being its ONLY write verb, asserted in tools.mode-map) IS that
// mechanism.
const AC_SKILLS_HANDOFF =
  "mindset-prod/memex-building-itself/specs/spec-300/acs/ac-48";

const ALL_MODES: AgentMode[] = [
  "spec",
  "drift",
  "scaffold",
  "standards",
  "issues",
  "skills",
];

describe("render_handoff — the shared cross-agent handoff (ac-11)", () => {
  it("is a display-only UI tool (never executes server-side)", () => {
    tagAc(AC_HANDOFF);
    expect(isUiTool("render_handoff")).toBe(true);
    const names = getToolDefinitions().map((t) => t.name);
    expect(names).toContain("render_handoff");
  });

  it("rides into EVERY mode so any agent can hand off out-of-scope work", () => {
    tagAc(AC_HANDOFF);
    // spec-300 ac-48: the skills agent inherits the same honest-refusal handoff —
    // render_handoff is present in skills mode too.
    tagAc(AC_SKILLS_HANDOFF);
    for (const mode of ALL_MODES) {
      const names = getToolDefinitions({ mode }).map((t) => t.name);
      expect(names).toContain("render_handoff");
    }
  });

  it("schema requires a target + prompt and offers an optional reason", () => {
    tagAc(AC_HANDOFF);
    const tool = getToolDefinitions().find((t) => t.name === "render_handoff");
    expect(tool).toBeDefined();
    const schema = tool!.input_schema as {
      properties?: Record<string, unknown>;
      required?: string[];
    };
    expect(schema.properties).toHaveProperty("target");
    expect(schema.properties).toHaveProperty("prompt");
    expect(schema.properties).toHaveProperty("reason");
    expect(schema.required?.sort()).toEqual(["prompt", "target"]);
  });
});
