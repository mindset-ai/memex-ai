// spec-31 ac-2 — "Every MCP tool surfaces with correct annotations
// (title + readOnlyHint OR destructiveHint) when reviewers inspect tools/list."
//
// The Anthropic Connectors Directory reviewer drives a `tools/list` request and
// inspects the annotation triple on EACH returned tool. ~30% of directory
// rejections cite missing/misclassified annotations.
//
// This test asserts against the LIVE registered catalogue — `createMcpServer`'s
// `_registeredTools` — not the `toolSpecs` source array. That distinction
// matters: the SDK's tools/list handler emits `annotations: tool.annotations`
// for every entry in `_registeredTools` (mcp.js), and that set includes
// `list_memexes`, which is registered directly on the server and is NOT a member
// of `toolSpecs`. The sibling tool-annotations.regression.test.ts iterates
// `toolSpecs` only, so it cannot see list_memexes — exactly the kind of tool a
// reviewer WOULD see in tools/list. Introspecting the registry closes that gap.
//
// Tagged to: mindset-prod/memex-building-itself/specs/spec-31/acs/ac-2

import { describe, it, expect } from "vitest";
import { tagAc } from "@memex-ai-ac/vitest";
import { createMcpServer } from "./tools.js";

const AC_2 = "mindset-prod/memex-building-itself/specs/spec-31/acs/ac-2";

// The SDK's tools/list handler reads each tool's `.annotations` off
// `_registeredTools` verbatim, so introspecting this map is equivalent to
// inspecting the tools/list response a reviewer receives.
interface RegisteredToolLike {
  annotations?: {
    title?: string;
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
  };
}

function registeredTools(): Record<string, RegisteredToolLike> {
  // userId is closed over by handlers but never read at registration time, so a
  // placeholder is enough to materialise the full catalogue (no DB access).
  const server = createMcpServer("spec-31-annotations-probe");
  return (
    server as unknown as { _registeredTools: Record<string, RegisteredToolLike> }
  )._registeredTools;
}

describe("spec-31 ac-2: tools/list annotations", () => {
  it("every tool in the tools/list catalogue carries a title + readOnly/destructive hints", () => {
    tagAc(AC_2);
    const tools = registeredTools();
    const names = Object.keys(tools);

    // t-7 shipped annotations on the full catalogue (~31 tools).
    expect(names.length).toBeGreaterThanOrEqual(31);

    for (const name of names) {
      const ann = tools[name].annotations;
      expect(ann, `${name} surfaces no annotations in tools/list`).toBeDefined();
      // title — Claude renders this in the tool picker.
      expect(
        typeof ann!.title === "string" && ann!.title.length > 0,
        `${name}: annotations.title must be a non-empty string`,
      ).toBe(true);
      // readOnlyHint OR destructiveHint — the behaviour classification the
      // reviewer relies on to decide whether Claude may call without confirming.
      expect(
        typeof ann!.readOnlyHint === "boolean" || typeof ann!.destructiveHint === "boolean",
        `${name}: must declare readOnlyHint and/or destructiveHint`,
      ).toBe(true);
    }
  });

  it("list_memexes — the MCP-only tool absent from toolSpecs — is annotated in tools/list", () => {
    tagAc(AC_2);
    // Explicitly pin the tool the toolSpecs-only test cannot see, since a
    // reviewer inspecting tools/list WILL see it.
    const ann = registeredTools()["list_memexes"]?.annotations;
    expect(ann, "list_memexes is missing from the registered catalogue").toBeDefined();
    expect(ann!.title).toBe("List Memexes");
    expect(ann!.readOnlyHint).toBe(true);
    expect(ann!.destructiveHint).toBe(false);
  });

  it("no tool is both read-only and destructive (incoherent classification)", () => {
    tagAc(AC_2);
    const tools = registeredTools();
    for (const [name, t] of Object.entries(tools)) {
      const ann = t.annotations;
      const both = !!ann?.readOnlyHint && !!ann?.destructiveHint;
      expect(both, `${name}: read-only and destructive are mutually exclusive`).toBe(false);
    }
  });

  it("titles are unique across the catalogue (Claude shows them in the picker)", () => {
    tagAc(AC_2);
    const titles = Object.values(registeredTools()).map((t) => t.annotations?.title);
    expect(titles.every((t) => typeof t === "string" && t.length > 0)).toBe(true);
    expect(new Set(titles).size).toBe(titles.length);
  });
});
