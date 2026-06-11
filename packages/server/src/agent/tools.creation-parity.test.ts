// spec-230 t-1 (ac-7): the in-app creation path must reach the SAME
// spec-authoring surface the MCP coding agent has — sections, decisions, AND
// acceptance criteria — so a substantial input fleshes out into a rich Spec
// instead of a thin Overview. The set is single-sourced from the @memex/shared
// manifest (std-16): every tool whose manifest `group` is 'planning' OR whose
// `trafficClass` is 'specify' (the latter pulls the AC-authoring verbs —
// create_ac / update_ac / link_ac_to_decision — out of the 'build' group),
// plus the read tools the creation agent needs for orientation (search_memex,
// get_doc), plus the render_* UI tools. Build-phase task verbs stay OUT.
//
// These tests pin that the creation surface is derived from the manifest and
// can't drift back to a hand-maintained 3-tool list.

import { describe, it, expect } from "vitest";
import { tagAc } from "@memex-ai-ac/vitest";
import { toolManifest } from "@memex/shared";
import { getCreationToolDefinitions, isUiTool } from "./tools.js";

const AC_CREATION_PARITY =
  "mindset-prod/memex-building-itself/specs/spec-230/acs/ac-7";

// Read tools the creation agent needs for orientation (overlap search + reading
// related Specs/Standards). Mirrors the allowlist the implementation derives.
const CREATION_READ_TOOLS = ["search_memex", "get_doc"];

/** The manifest-derived creation server-tool set, recomputed independently here
 *  so the equality assertion catches any hand-maintained drift in the impl. */
function manifestCreationServerNames(): string[] {
  return toolManifest
    .filter(
      (e) =>
        e.group === "planning" ||
        e.trafficClass === "specify" ||
        CREATION_READ_TOOLS.includes(e.name),
    )
    .map((e) => e.name)
    // list_memexes is registered inline in mcp/tools.ts, not in toolSpecs.
    .filter((n) => n !== "list_memexes");
}

describe("getCreationToolDefinitions — MCP creation parity (spec-230 t-1)", () => {
  it("exposes the full spec-authoring surface: sections, decisions, AND ACs", () => {
    tagAc(AC_CREATION_PARITY);
    const names = getCreationToolDefinitions().map((t) => t.name);
    for (const t of [
      "create_doc",
      "add_section",
      "update_section",
      "create_decision",
      "resolve_decision",
      "create_ac",
      "update_ac",
      "link_ac_to_decision",
      "search_memex",
      "get_doc",
    ]) {
      expect(names).toContain(t);
    }
  });

  it("does NOT leak build-phase task verbs into the creation surface", () => {
    tagAc(AC_CREATION_PARITY);
    const names = getCreationToolDefinitions().map((t) => t.name);
    expect(names).not.toContain("create_task");
    expect(names).not.toContain("update_task");
    expect(names).not.toContain("delete_task");
  });

  it("the render_* UI tools (incl. the render_confirmation mutation gate) ride along", () => {
    tagAc(AC_CREATION_PARITY);
    const names = getCreationToolDefinitions().map((t) => t.name);
    expect(names).toContain("render_confirmation");
  });

  it("the server-tool set EQUALS the manifest-derived creation set — no hand-maintained drift (std-16)", () => {
    tagAc(AC_CREATION_PARITY);
    const serverNames = getCreationToolDefinitions()
      .map((t) => t.name)
      .filter((n) => !isUiTool(n))
      .sort();
    const expected = [...new Set(manifestCreationServerNames())].sort();
    expect(serverNames).toEqual(expected);
  });

  it("is meaningfully broader than the old Overview-only 3-tool surface", () => {
    tagAc(AC_CREATION_PARITY);
    const serverNames = getCreationToolDefinitions()
      .map((t) => t.name)
      .filter((n) => !isUiTool(n));
    // Pre-spec-230 the creation surface was exactly create_doc + add_section +
    // search_memex. Parity means decision + AC authoring are now reachable.
    expect(serverNames.length).toBeGreaterThan(3);
    expect(serverNames).toContain("create_decision");
    expect(serverNames).toContain("create_ac");
  });

  it("the last tool carries a cache_control breakpoint (prompt-cache parity)", () => {
    tagAc(AC_CREATION_PARITY);
    const tools = getCreationToolDefinitions();
    const last = tools[tools.length - 1] as {
      cache_control?: { type: string };
    };
    expect(last.cache_control).toEqual({ type: "ephemeral" });
  });
});
