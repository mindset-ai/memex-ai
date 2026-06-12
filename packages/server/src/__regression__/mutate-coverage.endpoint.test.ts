// Endpoint coverage regression test (doc-16 t-11; bidirectional by spec-156 ac-25).
//
// Enumerates every mutation entry point the platform exposes and asserts each
// has a registered handler. Pairs with `mutate-coverage.service.test.ts` (t-12)
// which proves runtime emission at the service layer — together they catch
// both shapes of failure:
//   - A new mutation entry point that bypasses `mutate()` would be visible here
//     (the catalogue lists the expected tool/route) and would also fail t-12's
//     emission assertion against the underlying service.
//   - A new mutating service that forgets the Mutated<T> brand fails t-12.
//
// spec-156 ac-25 — the catalogue is no longer a hand-maintained, one-directional
// list. The set of MUTATING tools is DERIVED from the @memex/shared tool manifest
// via its `readOnlyHint` annotation (std-16: the manifest is the single source of
// the tool contract), and asserted BIDIRECTIONALLY:
//   (forward) every manifest tool with readOnlyHint=false appears in the coverage
//             catalogue — so adding a mutating tool without a coverage entry fails CI;
//   (reverse) every catalogued tool exists in the manifest AND is non-read-only
//             there — so a stale or mis-classified catalogue entry fails CI.
// The catalogue's (entity, action) pairs remain hand-authored documentation of
// what each tool emits; the NAME SET is what the manifest governs.
//
// Why structural (catalogue-based) rather than full JSON-RPC invocation:
// the MCP SDK transport requires real session/transport setup, and invoking
// every tool through the wire for a coverage gate adds startup cost without
// catching anything t-12 doesn't already catch — every MCP mutation tool
// ultimately calls one of the registered service functions, and t-12 exercises
// the entire mutating service surface.

import { describe, it, expect } from "vitest";
import { tagAc } from "@memex-ai-ac/vitest";
import { toolManifest } from "@memex/shared";
import { createMcpServer } from "../mcp/tools.js";
import { getToolDefinitions, isUiTool } from "../agent/tools.js";
import { toolSpecs } from "../agent/tool-specs.js";

const AC = "mindset-prod/memex-building-itself/specs/spec-156/acs";

const TEST_USER_ID = "00000000-0000-0000-0000-00000000beef";

function listMcpToolNames(): Set<string> {
  const server = createMcpServer(TEST_USER_ID);
  const tools = (server as unknown as { _registeredTools: Record<string, unknown> })
    ._registeredTools;
  return new Set(Object.keys(tools));
}

// ── The manifest-derived mutating set (spec-156 ac-25) ──────────────────────
// readOnlyHint=false in the @memex/shared manifest ⇒ the tool mutates state.
const manifestMutating = new Set(
  toolManifest.filter((e) => !e.readOnlyHint).map((e) => e.name),
);

// A tool whose readOnlyHint is false but which performs NO `mutate()`-wrapped DB
// write — it side-effects OUTSIDE the unified bus and so has no (entity, action)
// to catalogue. Each entry needs a one-line reason. (std-8's bus is for DB-row
// fan-out; external side-effects don't emit ChangeEvents.)
const NON_DB_MUTATORS: Record<string, string> = {
  memex__send_slack_message:
    "Sends a Slack message via the user's connected account — an external side-effect, not a Memex DB row. No mutate() write, so nothing to fan out on the bus.",
  memex__send_discord_message:
    "Sends a Discord message via the org's configured webhook (spec-138) — an external side-effect, not a Memex DB row. No mutate() write, so nothing to fan out on the bus.",
};

// Catalogue of mutation entry points by MCP tool name → the change-event shape its
// underlying service emits. The NAME SET here is governed by the manifest (the two
// assertions below pin it bidirectionally); the (entity, action) pairs document
// what each tool fires. Composite tools fire multiple events.
interface ToolMutation {
  entity: string;
  action: string;
}

const MUTATING_MCP_TOOLS: Record<string, ToolMutation[]> = {
  // documents.ts
  create_doc: [{ entity: "document", action: "created" }],
  update_doc: [{ entity: "document", action: "updated" }],
  // narrative + spec lifecycle (b-105: publish_brief → publish_spec)
  publish_spec: [{ entity: "document", action: "updated" }],
  // assess_spec: mode='consolidate' stamps narrativeLastConsolidatedAt via
  // markNarrativeConsolidated → document/updated (the other modes are read-only).
  assess_spec: [{ entity: "document", action: "updated" }],
  // sections.ts
  add_section: [{ entity: "section", action: "created" }],
  update_section: [{ entity: "section", action: "updated" }],
  retitle_section: [{ entity: "section", action: "updated" }],
  delete_section: [{ entity: "section", action: "deleted" }],
  // clauses.ts (spec-161) — every clause write dual-emits the clause key and the
  // owning section's `section.updated` (the section's derived content regenerates).
  add_clause: [
    { entity: "clause", action: "created" },
    { entity: "section", action: "updated" },
  ],
  edit_clause: [
    { entity: "clause", action: "updated" },
    { entity: "section", action: "updated" },
  ],
  delete_clause: [
    { entity: "clause", action: "deleted" },
    { entity: "section", action: "updated" },
  ],
  // decisions.ts
  create_decision: [{ entity: "decision", action: "created" }],
  update_decision: [{ entity: "decision", action: "updated" }],
  delete_decision: [{ entity: "decision", action: "updated" }], // soft-delete → status update
  resolve_decision: [{ entity: "decision", action: "updated" }],
  approve_candidate: [{ entity: "decision", action: "updated" }],
  reject_candidate: [{ entity: "decision", action: "updated" }],
  // tasks.ts
  create_task: [{ entity: "task", action: "created" }],
  update_task: [{ entity: "task", action: "updated" }],
  delete_task: [{ entity: "task", action: "deleted" }],
  // acs.ts
  create_ac: [{ entity: "ac", action: "created" }],
  // spec-234: provision_ac_emission mints an emission key → memex_emission_key.created
  // on the bus (the same mutate() path mintEmissionKey uses for the Settings-UI mint).
  provision_ac_emission: [{ entity: "memex_emission_key", action: "created" }],
  update_ac: [{ entity: "ac", action: "updated" }],
  delete_ac: [{ entity: "ac", action: "deleted" }],
  link_ac_to_decision: [{ entity: "ac", action: "updated" }],
  // spec-127: soft-hide / restore of orphaned test-events both emit ac:updated.
  discontinue_test_events: [{ entity: "ac", action: "updated" }],
  restore_test_events: [{ entity: "ac", action: "updated" }],
  // issues.ts
  register_issue: [{ entity: "issue", action: "created" }],
  update_issue: [{ entity: "issue", action: "updated" }],
  resolve_issue: [{ entity: "issue", action: "updated" }],
  convert_issue_to_task: [
    { entity: "task", action: "created" },
    { entity: "ac", action: "created" },
    { entity: "issue", action: "updated" },
  ],
  kick_task_to_issue: [
    { entity: "task", action: "deleted" },
    { entity: "issue", action: "updated" },
  ],
  // roles + assignment (doc-members.ts / doc-assignees.ts)
  set_spec_role: [
    { entity: "doc_member", action: "created" }, // promote
    { entity: "doc_member", action: "deleted" }, // demote
  ],
  assign_spec: [{ entity: "doc_assignee", action: "created" }],
  unassign_spec: [{ entity: "doc_assignee", action: "deleted" }],
  // comments.ts
  add_comment: [{ entity: "comment", action: "created" }],
  update_comment: [{ entity: "comment", action: "updated" }],
  // standards.ts — both dual-emit: an inner comment.created (from addComment) plus
  // the standard_drift aggregate event for the StandardList drift-count subscriber
  // (spec-143 dec-2; spec-156 FINDING 3 threads channel attribution into the latter).
  flag_drift: [
    { entity: "comment", action: "created" },
    { entity: "standard_drift", action: "created" },
  ],
  propose_standard_change: [
    { entity: "comment", action: "created" },
    { entity: "standard_drift", action: "created" },
  ],
};

describe("doc-16 t-11 / spec-156 ac-25: endpoint coverage — every mutation entry point is registered", () => {
  it("every catalogued mutating MCP tool is registered with the server", () => {
    const registered = listMcpToolNames();
    const missing: string[] = [];
    for (const name of Object.keys(MUTATING_MCP_TOOLS)) {
      if (!registered.has(name)) missing.push(name);
    }
    expect(
      missing,
      missing.length === 0
        ? ""
        : `Catalogued mutating MCP tools are not registered. Add the server.tool() ` +
          `registration in packages/server/src/mcp/tools.ts or remove the entry from ` +
          `the catalogue in this file.\n  - ${missing.join("\n  - ")}`,
    ).toEqual([]);
  });

  it("every catalogued tool has at least one expected (entity, action) declaration", () => {
    const empty: string[] = [];
    for (const [name, expected] of Object.entries(MUTATING_MCP_TOOLS)) {
      if (expected.length === 0) empty.push(name);
    }
    expect(
      empty,
      empty.length === 0
        ? ""
        : `These catalogued tools have no expected (entity, action) pairs. Either ` +
          `declare what they emit or remove them from the catalogue:\n  - ${empty.join("\n  - ")}`,
    ).toEqual([]);
  });

  it("UI tools (render_*) are NOT in the mutation catalogue (they pause the agent loop, not mutate state)", () => {
    const uiCatalogued: string[] = [];
    for (const name of Object.keys(MUTATING_MCP_TOOLS)) {
      if (isUiTool(name)) uiCatalogued.push(name);
    }
    expect(uiCatalogued).toEqual([]);
  });

  it("every catalogued mutating tool is also wired into the agent (or explicitly MCP-only)", () => {
    const agentNames = new Set(getToolDefinitions().map((t) => t.name));
    const missingFromAgent: string[] = [];
    for (const name of Object.keys(MUTATING_MCP_TOOLS)) {
      if (!agentNames.has(name)) missingFromAgent.push(name);
    }
    expect(
      missingFromAgent,
      missingFromAgent.length === 0
        ? ""
        : `These mutation tools exist on MCP but not in the agent registry — every ` +
          `mutating tool should be reachable from both surfaces per doc-14 dec-4:\n  - ${missingFromAgent.join("\n  - ")}`,
    ).toEqual([]);
  });

  it("the mutation catalogue is non-empty (sanity)", () => {
    expect(Object.keys(MUTATING_MCP_TOOLS).length).toBeGreaterThan(10);
  });

  // ── spec-156 ac-25: bidirectional derivation from the @memex/shared manifest ──

  it("ac-25: FORWARD — every mutating manifest tool (readOnlyHint=false) is covered", () => {
    tagAc(`${AC}/ac-25`);
    tagAc(`${AC}/ac-3`); // scope ac-3: enforcement-suite-fails-on-bypass guarantee
    const catalogued = new Set(Object.keys(MUTATING_MCP_TOOLS));
    const uncovered: string[] = [];
    for (const name of manifestMutating) {
      if (NON_DB_MUTATORS[name]) continue; // external side-effect, no bus event
      if (!catalogued.has(name)) uncovered.push(name);
    }
    expect(
      uncovered.sort(),
      uncovered.length === 0
        ? ""
        : `These tools are marked readOnlyHint=false in the @memex/shared manifest but ` +
          `are MISSING from the mutate-coverage catalogue. Adding a mutating tool without ` +
          `coverage fails CI (spec-156 ac-25). Add an (entity, action) entry to ` +
          `MUTATING_MCP_TOOLS in this file (or, if it has no DB write, to NON_DB_MUTATORS ` +
          `with a one-line reason):\n  - ${uncovered.join("\n  - ")}`,
    ).toEqual([]);
  });

  it("ac-25: REVERSE — every catalogued tool exists in the manifest and is non-read-only there", () => {
    tagAc(`${AC}/ac-25`);
    tagAc(`${AC}/ac-3`); // scope ac-3: enforcement-suite-fails-on-bypass guarantee
    const manifestByName = new Map(toolManifest.map((e) => [e.name, e]));
    const problems: string[] = [];
    for (const name of Object.keys(MUTATING_MCP_TOOLS)) {
      const entry = manifestByName.get(name);
      if (!entry) {
        problems.push(`${name}: catalogued but ABSENT from the @memex/shared manifest`);
      } else if (entry.readOnlyHint) {
        problems.push(
          `${name}: catalogued as mutating but the manifest marks it readOnlyHint=true`,
        );
      }
    }
    expect(
      problems,
      problems.length === 0
        ? ""
        : `Catalogue ↔ manifest mismatch (spec-156 ac-25):\n  - ${problems.join("\n  - ")}`,
    ).toEqual([]);
  });

  it("ac-25: the manifest readOnlyHint matches the live server tool-spec annotations (no drift)", () => {
    tagAc(`${AC}/ac-25`);
    // The manifest is the single source, but the server catalogue (tool-specs.ts)
    // also carries annotations.readOnlyHint for the MCP wire. They must agree, or
    // the manifest-derived mutating set would diverge from what the server exposes.
    const specByName = new Map(toolSpecs.map((s) => [s.name, s]));
    const mismatches: string[] = [];
    for (const entry of toolManifest) {
      const spec = specByName.get(entry.name);
      if (!spec) continue; // list_memexes is inline-only (not in toolSpecs) — name parity is the b-67 test's job.
      if (spec.annotations.readOnlyHint !== entry.readOnlyHint) {
        mismatches.push(
          `${entry.name}: manifest=${entry.readOnlyHint} vs tool-specs annotation=${spec.annotations.readOnlyHint}`,
        );
      }
    }
    expect(
      mismatches,
      mismatches.length === 0
        ? ""
        : `readOnlyHint drift between @memex/shared manifest and tool-specs.ts annotations ` +
          `(update one to match the other; the manifest is canonical):\n  - ${mismatches.join("\n  - ")}`,
    ).toEqual([]);
  });

  it("ac-25: NON_DB_MUTATORS only excuses genuinely non-read-only manifest tools", () => {
    tagAc(`${AC}/ac-25`);
    // Guard the escape hatch: every NON_DB_MUTATORS key must be a real manifest
    // tool that is readOnlyHint=false (otherwise it's exempting nothing, or
    // hiding a read tool's misclassification).
    const bad: string[] = [];
    for (const name of Object.keys(NON_DB_MUTATORS)) {
      if (!manifestMutating.has(name)) {
        bad.push(`${name}: not a readOnlyHint=false manifest tool — drop it from NON_DB_MUTATORS`);
      }
    }
    expect(bad, bad.join("\n")).toEqual([]);
  });
});

// Export so the service coverage test can cross-reference the catalogue.
export { MUTATING_MCP_TOOLS };
