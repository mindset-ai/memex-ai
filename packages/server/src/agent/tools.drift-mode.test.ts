// spec-143 t-4 (dec-6): the drift agent sees a FOCUSED tool surface — just the
// verbs needed to understand and report drift (search/read + flag/propose),
// plus the render_* UI tools (so render_confirmation can gate mutations). These
// tests pin the drift subset of getToolDefinitions and the isDriftModeTool gate
// the /tools/execute route uses to permit the subset to run with docId null.

import { describe, it, expect } from "vitest";
import { tagAc } from "@memex-ai-ac/vitest";
import { getToolDefinitions, isDriftModeTool, isUiTool } from "./tools.js";

const AC_DRIFT_MODE =
  "mindset-prod/memex-building-itself/specs/spec-143/acs/ac-12";
// ac-5 (scope, linked to dec-6): the drift agent's tools are scoped to drift
// management plus search_memex across ALL Spec kinds — these subset tests are
// the verification that the scoping claim holds.
const AC_SCOPED_TOOLS =
  "mindset-prod/memex-building-itself/specs/spec-143/acs/ac-5";
// ac-13 (implementation, dec-6): the drift-mode mechanism itself — posture
// overlay + server-side definition narrowing + fail-closed execute gate.
const AC_DRIFT_MECHANISM =
  "mindset-prod/memex-building-itself/specs/spec-143/acs/ac-13";

const EXPECTED_DRIFT_SERVER_TOOLS = [
  "flag_drift",
  "propose_standard_change",
  "search_memex",
  "get_doc",
  // spec-143: the drift agent can now HANDLE drift, not just report it —
  // list_comments (fetch the c-N ref), update_section (apply a rule change),
  // update_comment (resolve a drift / proposal comment).
  "list_comments",
  "update_section",
  "update_comment",
  // spec-175: Standards are clause-backed (spec-150 / spec-161), so
  // update_section hard-rejects on a Standard. The clause verbs are how the
  // drift agent actually edits rule text; the cl-N refs they need are surfaced
  // inline by get_doc.
  "add_clause",
  "edit_clause",
  "delete_clause",
];

describe("getToolDefinitions — drift mode subset", () => {
  it("returns ONLY the focused drift server tools plus the render_* UI tools", () => {
    tagAc(AC_DRIFT_MODE);
    tagAc(AC_SCOPED_TOOLS);
    tagAc(AC_DRIFT_MECHANISM);
    const names = getToolDefinitions({ mode: "drift" }).map((t) => t.name);

    // Every expected drift server tool is present.
    for (const name of EXPECTED_DRIFT_SERVER_TOOLS) {
      expect(names).toContain(name);
    }

    // render_confirmation (the mutation gate) and the other UI tools ride along.
    expect(names).toContain("render_confirmation");

    // No non-drift server tool leaks in (e.g. doc/decision/task/phase verbs).
    const serverNames = names.filter((n) => !isUiTool(n));
    expect(serverNames.sort()).toEqual([...EXPECTED_DRIFT_SERVER_TOOLS].sort());

    // spec-143: update_section IS now exposed (the drift agent applies rule
    // changes), but the broad doc / decision / task / phase verbs are still out.
    expect(names).toContain("update_section");
    expect(names).not.toContain("create_doc");
    expect(names).not.toContain("create_task");
    expect(names).not.toContain("resolve_decision");
    expect(names).not.toContain("publish_spec");
  });

  it("the default (no mode) tool surface is broader than the drift subset", () => {
    tagAc(AC_DRIFT_MODE);
    const full = getToolDefinitions().map((t) => t.name);
    const drift = getToolDefinitions({ mode: "drift" }).map((t) => t.name);
    expect(full.length).toBeGreaterThan(drift.length);
    // The full surface includes mutation verbs the drift subset omits.
    expect(full).toContain("create_task");
    expect(drift).not.toContain("create_task");
  });

  it("search_memex rides into drift mode UN-NARROWED — every Spec kind stays searchable", () => {
    // ac-5's explicit requirement: the drift agent searches the WHOLE Spec
    // corpus while reasoning about a drift item, not just Standards. The drift
    // subset reuses the one shared search_memex spec, so the kind enum (and the
    // omit-to-search-everything default) must survive the mode filter intact.
    tagAc(AC_SCOPED_TOOLS);
    const search = getToolDefinitions({ mode: "drift" }).find(
      (t) => t.name === "search_memex",
    );
    expect(search).toBeDefined();
    const kind = (
      search!.input_schema as {
        properties?: Record<string, { enum?: string[] }>;
        required?: string[];
      }
    ).properties?.kind;
    expect(kind?.enum).toEqual(["spec", "standard", "document", "decision"]);
    // kind is optional — omitting it searches every kind.
    expect(
      (search!.input_schema as { required?: string[] }).required ?? [],
    ).not.toContain("kind");
  });

  it("the last tool carries a cache_control breakpoint (parity with the full surface)", () => {
    tagAc(AC_DRIFT_MODE);
    const tools = getToolDefinitions({ mode: "drift" });
    const last = tools[tools.length - 1] as { cache_control?: { type: string } };
    expect(last.cache_control).toEqual({ type: "ephemeral" });
  });
});

describe("isDriftModeTool — the /tools/execute drift gate", () => {
  it("permits exactly the focused drift server tools", () => {
    tagAc(AC_DRIFT_MODE);
    tagAc(AC_SCOPED_TOOLS);
    for (const name of EXPECTED_DRIFT_SERVER_TOOLS) {
      expect(isDriftModeTool(name)).toBe(true);
    }
  });

  it("rejects non-drift tools (fail closed)", () => {
    tagAc(AC_DRIFT_MODE);
    tagAc(AC_DRIFT_MECHANISM);
    expect(isDriftModeTool("create_doc")).toBe(false);
    expect(isDriftModeTool("create_task")).toBe(false);
    expect(isDriftModeTool("resolve_decision")).toBe(false);
    // UI tools never execute server-side, so they aren't in the gate.
    expect(isDriftModeTool("render_confirmation")).toBe(false);
    expect(isDriftModeTool("nonexistent_tool")).toBe(false);
  });
});
