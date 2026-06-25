// spec-389 t-2 (dec-4): the render-tool family, generalised off spec-360's
// `_scaffold` prefix into ONE surface-agnostic set every in-app agent shares:
//   - render_navigate — move-and-highlight, with a per-surface target grammar
//     (surface = scaffold | standard | spec | issue; `ref` carries the
//     clause/section/issue target);
//   - render_quote — verbatim block (carries text, not a surface);
//   - render_handoff — the copyable handoff (spec-389 t-4, asserted there).
// These tests pin the generalised contract (ac-12) and the absence of any
// `render_scaffold_*` tool symbol (ac-13).

import { describe, it, expect } from "vitest";
import { tagAc } from "@memex-ai-ac/vitest";
import { getToolDefinitions, isUiTool } from "./tools.js";
import type { AgentMode } from "./tools.js";

// ac-12 (implementation, dec-4): one render family — render_navigate (per-surface
// target union) + render_quote — shared by all agents, no _scaffold variants.
const AC_FAMILY =
  "mindset-prod/memex-building-itself/specs/spec-389/acs/ac-12";
// ac-13 (implementation, dec-5): no render_scaffold_* symbols remain — the
// generalisation was built on the merged spec-360 foundation.
const AC_NO_SCAFFOLD_PREFIX =
  "mindset-prod/memex-building-itself/specs/spec-389/acs/ac-13";

const ALL_MODES: AgentMode[] = [
  "spec",
  "drift",
  "scaffold",
  "standards",
  "issues",
];

describe("render family — render_navigate + render_quote (ac-12)", () => {
  it("both are present on the default surface and classify as UI tools", () => {
    tagAc(AC_FAMILY);
    const names = getToolDefinitions().map((t) => t.name);
    expect(names).toContain("render_navigate");
    expect(names).toContain("render_quote");
    expect(isUiTool("render_navigate")).toBe(true);
    expect(isUiTool("render_quote")).toBe(true);
  });

  it("render_navigate carries the per-surface target grammar (surface + ref)", () => {
    tagAc(AC_FAMILY);
    const nav = getToolDefinitions().find((t) => t.name === "render_navigate");
    expect(nav).toBeDefined();
    const schema = nav!.input_schema as {
      properties?: Record<string, { enum?: string[] }>;
      required?: string[];
    };
    // surface discriminant spans every agent surface…
    expect(schema.properties?.surface?.enum).toEqual([
      "scaffold",
      "standard",
      "spec",
      "issue",
    ]);
    // …and a generic ref for the standard/spec/issue target.
    expect(schema.properties).toHaveProperty("ref");
    // scaffold dims survive for the scaffold surface.
    expect(schema.properties).toHaveProperty("phase");
    expect(schema.properties).toHaveProperty("button");
    // everything optional — an empty target shows the global/always-applies view.
    expect(schema.required ?? []).toEqual([]);
  });

  it("render_quote is surface-agnostic — requires only `text`", () => {
    tagAc(AC_FAMILY);
    const quote = getToolDefinitions().find((t) => t.name === "render_quote");
    expect(quote).toBeDefined();
    const schema = quote!.input_schema as {
      properties?: Record<string, unknown>;
      required?: string[];
    };
    expect(schema.properties).toHaveProperty("text");
    expect(schema.properties).toHaveProperty("copyable");
    expect(schema.required).toEqual(["text"]);
  });

  it("the render family rides into EVERY mode (UI tools always included)", () => {
    tagAc(AC_FAMILY);
    for (const mode of ALL_MODES) {
      const names = getToolDefinitions({ mode }).map((t) => t.name);
      expect(names).toContain("render_navigate");
      expect(names).toContain("render_quote");
    }
  });
});

describe("no render_scaffold_* tool symbols remain (ac-13)", () => {
  it("no tool in any mode is named render_scaffold_*", () => {
    tagAc(AC_NO_SCAFFOLD_PREFIX);
    for (const mode of ALL_MODES) {
      const names = getToolDefinitions({ mode }).map((t) => t.name);
      const scaffoldPrefixed = names.filter((n) =>
        n.startsWith("render_scaffold_"),
      );
      expect(scaffoldPrefixed).toEqual([]);
    }
    // The default surface too.
    const def = getToolDefinitions().map((t) => t.name);
    expect(def.filter((n) => n.startsWith("render_scaffold_"))).toEqual([]);
  });
});
