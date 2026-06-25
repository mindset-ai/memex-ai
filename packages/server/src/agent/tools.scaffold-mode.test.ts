// spec-360 issue-5 / issue-6 — the scaffold assistant's display-only UI tools.
//
// render_quote (verbatim quote block) and render_navigate
// (move the on-screen scaffold to a circumstance) are React-only `render_*` UI
// tools. They ride the agent's tool surface (incl. scaffold mode) like every
// other render_* tool; they never execute server-side. These tests pin:
//   - getToolDefinitions() exposes both, in scaffold mode and the default mode;
//   - isUiTool() classifies both as UI tools;
//   - their schemas carry the documented props (text required / source optional
//     for quote; the four optional target dims for navigate).

import { describe, it, expect } from "vitest";
import { tagAc } from "@memex-ai-ac/vitest";
import { getToolDefinitions, isUiTool } from "./tools.js";

// ac-6 (implementation): the scaffold mode dispatches through the existing
// StateGraph + ChatPanel host — no new agent class. The render_* surface
// (these display tools) rides that same host.
const AC_HOST =
  "mindset-prod/memex-building-itself/specs/spec-360/acs/ac-6";
// ac-9 (implementation): the assistant drives the spec-343 surface — navigate
// is how it moves the on-screen scaffold.
const AC_SURFACE =
  "mindset-prod/memex-building-itself/specs/spec-360/acs/ac-9";

describe("render_quote — display-only UI tool (issue-5, ac-6)", () => {
  it("getToolDefinitions() includes render_quote in the default surface", () => {
    tagAc(AC_HOST);
    const names = getToolDefinitions().map((t) => t.name);
    expect(names).toContain("render_quote");
  });

  it("is present in scaffold mode (uiTools ride along)", () => {
    tagAc(AC_HOST);
    const names = getToolDefinitions({ mode: "scaffold" }).map((t) => t.name);
    expect(names).toContain("render_quote");
  });

  it("isUiTool('render_quote') === true (never executes server-side)", () => {
    tagAc(AC_HOST);
    expect(isUiTool("render_quote")).toBe(true);
  });

  it("schema requires `text` and offers an optional `source`", () => {
    tagAc(AC_HOST);
    const tool = getToolDefinitions({ mode: "scaffold" }).find(
      (t) => t.name === "render_quote",
    );
    expect(tool).toBeDefined();
    const schema = tool!.input_schema as {
      properties?: Record<string, unknown>;
      required?: string[];
    };
    expect(schema.properties).toHaveProperty("text");
    expect(schema.properties).toHaveProperty("source");
    expect(schema.required).toEqual(["text"]);
  });

  // spec-360 issue-13 — copyable handoff. The `copyable` boolean turns the quote
  // into a copy-to-clipboard prompt the agent hands off (a Standard / new Spec it
  // can't author itself). The schema must expose it so the model can set it.
  it("schema includes the optional `copyable` boolean (issue-13)", () => {
    tagAc(AC_HOST);
    const tool = getToolDefinitions({ mode: "scaffold" }).find(
      (t) => t.name === "render_quote",
    );
    expect(tool).toBeDefined();
    const schema = tool!.input_schema as {
      properties?: Record<string, { type?: string }>;
      required?: string[];
    };
    expect(schema.properties).toHaveProperty("copyable");
    expect(schema.properties!.copyable.type).toBe("boolean");
    // It stays OPTIONAL — only `text` is required.
    expect(schema.required).toEqual(["text"]);
  });
});

describe("render_navigate — display-only UI tool (issue-6, ac-9)", () => {
  it("getToolDefinitions() includes render_navigate in the default surface", () => {
    tagAc(AC_SURFACE);
    const names = getToolDefinitions().map((t) => t.name);
    expect(names).toContain("render_navigate");
  });

  it("is present in scaffold mode (uiTools ride along)", () => {
    tagAc(AC_SURFACE);
    const names = getToolDefinitions({ mode: "scaffold" }).map((t) => t.name);
    expect(names).toContain("render_navigate");
  });

  it("isUiTool('render_navigate') === true (never executes server-side)", () => {
    tagAc(AC_SURFACE);
    expect(isUiTool("render_navigate")).toBe(true);
  });

  it("schema mirrors GuidanceBlock['target'] — all four target dims optional", () => {
    tagAc(AC_SURFACE);
    const tool = getToolDefinitions({ mode: "scaffold" }).find(
      (t) => t.name === "render_navigate",
    );
    expect(tool).toBeDefined();
    const schema = tool!.input_schema as {
      properties?: Record<string, unknown>;
      required?: string[];
    };
    expect(schema.properties).toHaveProperty("phase");
    expect(schema.properties).toHaveProperty("tool");
    expect(schema.properties).toHaveProperty("transition");
    expect(schema.properties).toHaveProperty("button");
    // empty target = always-applies / global → nothing required.
    expect(schema.required ?? []).toEqual([]);
  });
});
