// spec-389 t-3 (dec-2): the per-mode tool gate, generalised from the
// drift/scaffold-specific booleans into ONE server-owned `MODE_TOOLS` map.
// These tests pin:
//   - getToolDefinitions({mode}) exposes EXACTLY each scoped mode's subset plus
//     the render_* UI tools (ac-9);
//   - isToolAllowedInMode — the predicate /tools/execute uses to 403 anything
//     outside the active mode's subset — permits exactly the subset and fails
//     closed on everything else (ac-10);
//   - `spec` (and an absent mode) is the UNRESTRICTED surface, broader than any
//     scoped mode (the spec agent is governed by phase/reviewer gates, not a
//     mode subset).

import { describe, it, expect } from "vitest";
import { tagAc } from "@memex-ai-ac/vitest";
import {
  getToolDefinitions,
  isToolAllowedInMode,
  isUiTool,
  type AgentMode,
} from "./tools.js";

// ac-9 (implementation, dec-2): MODE_TOOLS defines each mode's subset; the
// definition filter exposes exactly that per mode.
const AC_MODE_MAP =
  "mindset-prod/memex-building-itself/specs/spec-389/acs/ac-9";
// ac-10 (implementation, dec-2): /tools/execute rejects (403) any tool not in
// the active mode's set — isToolAllowedInMode is that gate predicate.
const AC_GATE =
  "mindset-prod/memex-building-itself/specs/spec-389/acs/ac-10";

// The read/grounding base every scoped mode shares.
const READ_BASE = ["search_memex", "get_doc"];

// The expected server-tool subsets per scoped mode (the render_* UI tools ride
// along on top and are asserted separately).
const EXPECTED: Record<Exclude<AgentMode, "spec">, string[]> = {
  drift: [
    "flag_drift",
    "propose_standard_change",
    "search_memex",
    "get_doc",
    "list_comments",
    "update_section",
    "update_comment",
    "add_clause",
    "edit_clause",
    "delete_clause",
  ],
  scaffold: ["propose_scaffold_change", "search_memex", "get_doc"],
  standards: [
    "search_memex",
    "get_doc",
    "list_comments",
    "add_section",
    "retitle_section",
    "update_section",
    "add_clause",
    "edit_clause",
    "delete_clause",
    "propose_standard_change",
    "flag_drift",
  ],
  issues: [
    "search_memex",
    "get_doc",
    "register_issue",
    "list_issues",
    "get_issue",
    "update_issue",
    "resolve_issue",
    "convert_issue_to_task",
    "search_issues",
  ],
};

const SCOPED_MODES = Object.keys(EXPECTED) as Exclude<AgentMode, "spec">[];

describe("getToolDefinitions — each scoped mode exposes exactly its subset (ac-9)", () => {
  for (const mode of SCOPED_MODES) {
    it(`${mode} mode → exactly its MODE_TOOLS server subset + render_* UI tools`, () => {
      tagAc(AC_MODE_MAP);
      const names = getToolDefinitions({ mode }).map((t) => t.name);

      // The common read/grounding base is present in every scoped mode.
      for (const base of READ_BASE) expect(names).toContain(base);

      // Exactly the expected server tools — no more, no less.
      const serverNames = names.filter((n) => !isUiTool(n)).sort();
      expect(serverNames).toEqual([...EXPECTED[mode]].sort());

      // render_confirmation (the universal mutation gate) and the UI tools ride
      // along in every mode.
      expect(names).toContain("render_confirmation");

      // The last tool carries the cache_control breakpoint (parity with full).
      const tools = getToolDefinitions({ mode });
      const last = tools[tools.length - 1] as {
        cache_control?: { type: string };
      };
      expect(last.cache_control).toEqual({ type: "ephemeral" });
    });
  }

  it("the standards agent can author but cannot reach Spec/task/decision verbs", () => {
    tagAc(AC_MODE_MAP);
    const names = getToolDefinitions({ mode: "standards" }).map((t) => t.name);
    expect(names).toContain("add_section");
    expect(names).toContain("propose_standard_change");
    expect(names).not.toContain("create_task");
    expect(names).not.toContain("resolve_decision");
    expect(names).not.toContain("register_issue");
  });

  it("the issues agent can manage Issues but cannot author Standards or Spec body", () => {
    tagAc(AC_MODE_MAP);
    const names = getToolDefinitions({ mode: "issues" }).map((t) => t.name);
    expect(names).toContain("register_issue");
    expect(names).toContain("convert_issue_to_task");
    expect(names).not.toContain("propose_standard_change");
    expect(names).not.toContain("update_section");
    expect(names).not.toContain("create_decision");
  });

  it("spec (and absent) mode is unrestricted — broader than any scoped mode", () => {
    tagAc(AC_MODE_MAP);
    const full = getToolDefinitions().map((t) => t.name);
    const spec = getToolDefinitions({ mode: "spec" }).map((t) => t.name);
    // 'spec' behaves identically to passing no mode (unrestricted surface).
    expect(spec.sort()).toEqual(full.sort());
    // It carries the broad mutation verbs the scoped modes omit.
    expect(full).toContain("create_task");
    for (const mode of SCOPED_MODES) {
      const scoped = getToolDefinitions({ mode }).map((t) => t.name);
      expect(full.length).toBeGreaterThan(scoped.length);
    }
  });
});

describe("isToolAllowedInMode — the /tools/execute per-mode gate (ac-10)", () => {
  for (const mode of SCOPED_MODES) {
    it(`${mode} mode permits exactly its subset and fails closed otherwise`, () => {
      tagAc(AC_GATE);
      // Every tool in the subset is permitted.
      for (const name of EXPECTED[mode]) {
        expect(isToolAllowedInMode(mode, name)).toBe(true);
      }
      // A tool from a sibling mode that isn't in this subset is rejected.
      expect(isToolAllowedInMode(mode, "create_doc")).toBe(false);
      expect(isToolAllowedInMode(mode, "create_task")).toBe(false);
      // Unknown tools fail closed.
      expect(isToolAllowedInMode(mode, "nonexistent_tool")).toBe(false);
    });
  }

  it("scoped modes do NOT permit each other's exclusive write verbs", () => {
    tagAc(AC_GATE);
    // issues-only verb is rejected in standards mode, and vice-versa.
    expect(isToolAllowedInMode("standards", "register_issue")).toBe(false);
    expect(isToolAllowedInMode("issues", "propose_standard_change")).toBe(false);
    // scaffold's authoring verb is rejected in drift mode.
    expect(isToolAllowedInMode("drift", "propose_scaffold_change")).toBe(false);
  });

  it("spec mode (and an absent mode) is unrestricted at the gate", () => {
    tagAc(AC_GATE);
    expect(isToolAllowedInMode("spec", "create_task")).toBe(true);
    expect(isToolAllowedInMode(undefined, "create_task")).toBe(true);
    expect(isToolAllowedInMode("spec", "anything_at_all")).toBe(true);
  });
});
