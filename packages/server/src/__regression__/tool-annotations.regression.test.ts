// Anthropic Connectors Directory (b-31 W2) requires every MCP tool to carry
// the `annotations: { title, readOnlyHint, destructiveHint }` triple. ~30% of
// directory rejections cite missing or misclassified annotations, so this
// regression test guards against two failure modes:
//
//   1. A new tool ships without annotations (caught by the type — but a future
//      refactor could weaken the type, so we also assert at runtime).
//   2. A read tool is marked `readOnlyHint: false`, or a mutating tool is marked
//      `readOnlyHint: true`. Misclassifying a destructive tool as read-only
//      means Claude calls it without user confirmation — explicitly called out
//      in b-31 R2.
//
// The "expected classification" table below is the source of truth. Update it
// in lockstep with the spec — diverging from it fails the test.

import { describe, it, expect } from "vitest";
import { toolSpecs } from "../agent/tool-specs.js";

// Classification matrix — keep in sync with the spec annotations.
// Read-only: list_*, get_*, search_*, code_search, list_memexes, export_doc.
// Destructive (irreversible): delete_task, delete_ac, kick_task_to_issue
// (deletes the agent Task — irreversible row removal, spec-112 ac-31).
// Everything else: writing, but reversible.
const READ_ONLY = new Set<string>([
  "list_docs",
  "get_doc",
  "list_tasks",
  "list_comments",
  "search_memex",
  "list_repos",
  "get_repo",
  "list_symbols",
  "get_symbol",
  "get_file",
  "code_search",
  "list_acs",
  "get_ac",
  "get_information",
  // export_doc (spec-100): reads a doc and renders lossless export markdown —
  // no mutation, so readOnlyHint: true.
  "export_doc",
  // Issues (spec-112): the read side of the issue tool surface.
  "list_issues",
  "get_issue",
  "search_issues",
  // Roles (spec-118): the read side of the roles tool surface.
  "get_spec_roles",
]);

const DESTRUCTIVE = new Set<string>(["delete_task", "delete_ac", "kick_task_to_issue"]);

describe("regression: MCP tool annotations (b-31 W2)", () => {
  it("every shared spec carries annotations", () => {
    for (const spec of toolSpecs) {
      expect(spec.annotations, `${spec.name} is missing annotations`).toBeDefined();
      expect(spec.annotations.title.length, `${spec.name} annotation.title is empty`).toBeGreaterThan(0);
      expect(typeof spec.annotations.readOnlyHint).toBe("boolean");
      expect(typeof spec.annotations.destructiveHint).toBe("boolean");
    }
  });

  it("read-only classification matches the expected matrix", () => {
    for (const spec of toolSpecs) {
      const expected = READ_ONLY.has(spec.name);
      expect(
        spec.annotations.readOnlyHint,
        `${spec.name}: readOnlyHint should be ${expected} (verify by checking what services the handler calls)`,
      ).toBe(expected);
    }
  });

  it("destructive classification matches the expected matrix", () => {
    for (const spec of toolSpecs) {
      const expected = DESTRUCTIVE.has(spec.name);
      expect(
        spec.annotations.destructiveHint,
        `${spec.name}: destructiveHint should be ${expected} — destructive means irreversible (delete-row, drop-table). Update_* are reversible and should be false`,
      ).toBe(expected);
    }
  });

  it("a tool cannot be both read-only and destructive", () => {
    for (const spec of toolSpecs) {
      const both = spec.annotations.readOnlyHint && spec.annotations.destructiveHint;
      expect(both, `${spec.name}: read-only and destructive are mutually exclusive`).toBe(false);
    }
  });

  it("titles are unique (Claude shows them in the tool picker)", () => {
    const titles = toolSpecs.map((s) => s.annotations.title);
    const unique = new Set(titles);
    expect(unique.size).toBe(titles.length);
  });
});
