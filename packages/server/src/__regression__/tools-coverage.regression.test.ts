// Parity gate enforcing dec-4 of doc-14: the React UI agent and the MCP server
// expose the same tool catalogue. Every non-UI agent tool is also a registered
// MCP tool, and every MCP tool (except a small justified MCP_ONLY whitelist) is
// also wired into the agent.
//
// History: this test was originally written for doc-5 t-8 with a much larger
// MCP_ONLY whitelist because the React UI agent received full doc context via
// the system prompt and didn't need read-side tools (list_*, get_*). Per
// doc-14 dec-4 (lockstep parity), the rationale was revisited:
//
//   - `list_memexes` stays MCP-only by design — the React UI agent is already
//     memex-scoped via the user's session, so it has no reason to enumerate.
//
//   - `list_docs`, `get_doc`, `list_tasks`, `list_comments` stay MCP-only
//     because the React UI agent receives the full doc state via system-prompt
//     injection (see agent/context-builder.ts). Adding them to the agent would
//     duplicate context and bloat the prompt.
//
// All other tools live on both surfaces. Cut tools (per doc-14) live on
// neither surface and instead surface a structured migration error from the
// MCP request handler — see migration-map.ts. This test asserts every cut
// name is absent on both surfaces.

import { describe, it, expect } from "vitest";
import { tagAc } from "@memex-ai-ac/vitest";
import { toolManifest } from "@memex/shared";
import { createMcpServer } from "../mcp/tools.js";
import { getToolDefinitions, isUiTool } from "../agent/tools.js";
import { manifestVsSpecsDiff } from "../agent/tool-specs.js";
import { REMOVED_TOOL_NAMES } from "../mcp/migration-map.js";

const SPEC_143 = "mindset-prod/memex-building-itself/specs/spec-143";

const TEST_USER_ID = "00000000-0000-0000-0000-00000000beef";

function listMcpToolNames(): Set<string> {
  const server = createMcpServer(TEST_USER_ID);
  const tools = (server as unknown as { _registeredTools: Record<string, unknown> })
    ._registeredTools;
  return new Set(Object.keys(tools));
}

function listAgentToolNames(): { all: Set<string>; nonUi: Set<string> } {
  const all = new Set<string>();
  const nonUi = new Set<string>();
  for (const t of getToolDefinitions()) {
    all.add(t.name);
    if (!isUiTool(t.name)) nonUi.add(t.name);
  }
  return { all, nonUi };
}

// Tools that legitimately live on only one surface — keep this list short
// and explicit so additions are intentional.
const MCP_ONLY = new Set<string>([
  // Memex enumeration: the React UI agent is already memex-scoped via session.
  "list_memexes",
  // Read-only doc/task/comment introspection: the React UI agent has the full
  // document state injected via the system prompt (see agent/context-builder.ts),
  // so adding these would duplicate context and bloat the prompt.
  "list_docs",
  "get_doc",
  "list_tasks",
  "list_comments",
]);

const AGENT_ONLY_NON_UI = new Set<string>(); // empty: every non-UI agent tool should also be on MCP

describe("regression: agent ↔ MCP tool coverage parity (doc-14 dec-4)", () => {
  it("every non-UI agent tool is also exposed via MCP", () => {
    const mcp = listMcpToolNames();
    const { nonUi } = listAgentToolNames();

    const missingFromMcp: string[] = [];
    for (const name of nonUi) {
      if (AGENT_ONLY_NON_UI.has(name)) continue;
      if (!mcp.has(name)) missingFromMcp.push(name);
    }

    expect(missingFromMcp, missingFromMcp.length === 0
      ? ""
      : `These tools are wired into the agent but not exposed via /mcp. ` +
        `Either add the matching server.tool(...) registration in packages/server/src/mcp/tools.ts, ` +
        `or add the name to AGENT_ONLY_NON_UI here with a justification.\n  - ${missingFromMcp.join("\n  - ")}`,
    ).toEqual([]);
  });

  it("every MCP tool (except MCP_ONLY) is also wired into the agent", () => {
    const mcp = listMcpToolNames();
    const { nonUi } = listAgentToolNames();

    const missingFromAgent: string[] = [];
    for (const name of mcp) {
      if (MCP_ONLY.has(name)) continue;
      if (!nonUi.has(name)) missingFromAgent.push(name);
    }

    expect(missingFromAgent, missingFromAgent.length === 0
      ? ""
      : `These tools are exposed via /mcp but not wired into the agent server-tool registry. ` +
        `Either add the matching definition in packages/server/src/agent/tools.ts, ` +
        `or add the name to MCP_ONLY here with a justification.\n  - ${missingFromAgent.join("\n  - ")}`,
    ).toEqual([]);
  });

  it("list_memexes is MCP-only (the in-app agent doesn't need to enumerate memexes)", () => {
    const mcp = listMcpToolNames();
    const { all: agentAll } = listAgentToolNames();
    expect(mcp.has("list_memexes")).toBe(true);
    expect(agentAll.has("list_memexes")).toBe(false);
  });

  it("UI tools are agent-only (they pause the loop and require user input)", () => {
    const mcp = listMcpToolNames();
    const { all: agentAll } = listAgentToolNames();
    const uiNames = [
      "render_action_buttons",
      "render_choices",
      "render_confirmation",
      "render_progress",
      "render_callout",
      "render_steps",
    ];
    for (const name of uiNames) {
      expect(agentAll.has(name), `agent should expose ${name}`).toBe(true);
      expect(mcp.has(name), `MCP must NOT expose ${name}`).toBe(false);
    }
  });

  it("doc-14 cuts: every removed tool name is absent from both surfaces", () => {
    const mcp = listMcpToolNames();
    const { all: agentAll } = listAgentToolNames();

    const stillOnMcp: string[] = [];
    const stillOnAgent: string[] = [];
    for (const oldName of REMOVED_TOOL_NAMES) {
      if (mcp.has(oldName)) stillOnMcp.push(oldName);
      if (agentAll.has(oldName)) stillOnAgent.push(oldName);
    }

    expect(stillOnMcp, stillOnMcp.length === 0
      ? ""
      : `Removed tools still in the MCP registry — they should be cut and surface a migration error via migration-map.ts:\n  - ${stillOnMcp.join("\n  - ")}`,
    ).toEqual([]);
    expect(stillOnAgent, stillOnAgent.length === 0
      ? ""
      : `Removed tools still in the agent registry:\n  - ${stillOnAgent.join("\n  - ")}`,
    ).toEqual([]);
  });

  // SKIP: doc-24 — 10 tools commented out (7 codebase + 3 standards) lowers active count below the doc-14 range. Restore alongside the tools.
  it.skip("MCP tool count is in the doc-14 target range (28-32)", () => {
    const mcp = listMcpToolNames();
    expect(mcp.size, `Got ${mcp.size} tools: ${[...mcp].sort().join(", ")}`).toBeGreaterThanOrEqual(28);
    expect(mcp.size, `Got ${mcp.size} tools: ${[...mcp].sort().join(", ")}`).toBeLessThanOrEqual(32);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// Per-field description parity (doc-2 t-2)
//
// The canonical spec lives in `agent/tool-specs.ts`. Each zod field carries a
// `.describe(...)` so the Anthropic tool definition produced by `getToolDefinitions()`
// surfaces the same per-field text the MCP `server.tool(...)` registration does
// (the MCP SDK converts the same zod shape internally — both paths read from
// one source). The assertion below pins this: if a future spec edit drops a
// `.describe()` from a field, the test fails.
//
// We assert on the agent's converted JSON Schema (the surface most likely to
// drift, since the converter sits between zod and Anthropic). Because both
// surfaces walk the same zod shape, this implicitly proves parity — a missing
// description on the agent side means the MCP side lacks it too.
// ──────────────────────────────────────────────────────────────────────────

describe("regression: per-field description coverage (doc-2 t-2)", () => {
  it("every server-tool input_schema property carries a non-empty description", () => {
    // UI tools (render_*) define their own JSON Schema by hand and aren't part
    // of the spec catalogue — exclude them from the parity guarantee. The
    // server-side spec tools are the catalogue dec-4 mandates.
    const missing: string[] = [];
    for (const tool of getToolDefinitions()) {
      if (isUiTool(tool.name)) continue;
      const props = tool.input_schema.properties as Record<string, { description?: string }>;
      for (const [fieldName, schema] of Object.entries(props)) {
        const desc = schema?.description;
        if (!desc || desc.trim().length === 0) {
          missing.push(`${tool.name}.${fieldName}`);
        }
      }
    }
    expect(missing, missing.length === 0
      ? ""
      : `These spec fields lack a .describe() — Anthropic and MCP both lose context. ` +
        `Add .describe('…') to each in packages/server/src/agent/tool-specs.ts:\n  - ${missing.join("\n  - ")}`,
    ).toEqual([]);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// Manifest ↔ MCP catalogue parity (b-67 t-4)
//
// The single-source tool manifest in `@memex/shared/tool-manifest.ts` is the
// canonical, plain-data description of the coding-agent MCP tool surface. It
// feeds the React UI Init Prompt's MEMEX_MCP_TOOLS_REFERENCE block. The live
// MCP catalogue is the set of tools the server actually registers
// (`toolSpecs` + the inline `list_memexes`). These two MUST stay in lockstep:
// the agent-only `render_*` UI tools are not on MCP so they never appear in
// the manifest, and `list_memexes` appears in both.
//
// If a tool is added / removed / renamed in tool-specs.ts (or mcp/tools.ts),
// this test fails until `packages/shared/src/tool-manifest.ts` is updated to
// match — that's the whole point of the manifest being single-source.
// ──────────────────────────────────────────────────────────────────────────

describe("regression: tool manifest ↔ MCP catalogue parity (b-67 t-4)", () => {
  it("the manifest tool-set exactly equals the registered MCP surface", () => {
    const manifestNames = new Set(toolManifest.map((e) => e.name));
    const mcpNames = listMcpToolNames();

    const inManifestNotMcp = [...manifestNames].filter((n) => !mcpNames.has(n)).sort();
    const inMcpNotManifest = [...mcpNames].filter((n) => !manifestNames.has(n)).sort();

    const drifted = inManifestNotMcp.length > 0 || inMcpNotManifest.length > 0;
    expect(drifted, drifted
      ? `The single-source tool manifest has drifted from the live MCP catalogue. ` +
        `Update packages/shared/src/tool-manifest.ts so its entries match the registered MCP tools ` +
        `(every toolSpecs entry + the inline list_memexes; render_* UI tools are agent-only and must NOT appear).` +
        (inManifestNotMcp.length > 0
          ? `\n  In the manifest but NOT registered on MCP (remove or fix name):\n    - ${inManifestNotMcp.join("\n    - ")}`
          : "") +
        (inMcpNotManifest.length > 0
          ? `\n  Registered on MCP but MISSING from the manifest (add an entry):\n    - ${inMcpNotManifest.join("\n    - ")}`
          : "")
      : "",
    ).toBe(false);

    // Equivalent assertion phrased as set equality — pins the exact name set.
    expect(manifestNames).toEqual(mcpNames);
  });

  // spec-143 dec-1 (ac-6 / ac-1): the two standards-drift verbs are restored —
  // uncommented in tool-specs.ts so they register on the MCP surface AND added
  // to the @memex/shared manifest (std-16 single source). They reach both the
  // in-UI drift agent and MCP coding agents.
  it("flag_drift and propose_standard_change are restored on both the manifest and the MCP surface (spec-143 dec-1)", () => {
    tagAc(`${SPEC_143}/acs/ac-6`);
    tagAc(`${SPEC_143}/acs/ac-1`);
    const manifestNames = new Set(toolManifest.map((e) => e.name));
    const mcpNames = listMcpToolNames();
    const { all: agentAll } = listAgentToolNames();

    for (const name of ["flag_drift", "propose_standard_change"]) {
      expect(manifestNames.has(name), `${name} missing from @memex/shared manifest`).toBe(true);
      expect(mcpNames.has(name), `${name} not registered on the MCP surface`).toBe(true);
      // Reaches the in-UI agent surface too (the drift agent's allow-list source).
      expect(agentAll.has(name), `${name} not wired into the agent tool registry`).toBe(true);
    }
  });

  it("the manifest matches toolSpecs (minus the inline list_memexes)", () => {
    // Secondary guard: the manifest's non-list_memexes names should equal the
    // toolSpecs names exactly. manifestVsSpecsDiff() lives next to the spec
    // array so the failure points at the canonical source.
    const { inSpecsNotManifest, inManifestNotSpecs } = manifestVsSpecsDiff();
    expect({ inSpecsNotManifest, inManifestNotSpecs }).toEqual({
      inSpecsNotManifest: [],
      inManifestNotSpecs: [],
    });
  });
});
