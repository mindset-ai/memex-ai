// spec-106 t-3 — cross-surface parity for the lens-shape GuidanceBlock.
//
// **ac-13** — "The specify-phase lens GuidanceBlock appears in the `toNudge`
// footer for BOTH the MCP agent and the React doc-chat agent."
//
// The structural truth (spec-68 dec-9, documented at mcp/tools.ts:312 as a
// "load-bearing parity guarantee"): both surfaces compose the phase-guidance
// footer through the SAME path —
//
//   formatState → formatFullDocState → renderSpecPhaseGuidance → toNudge
//
// The only surface-specific input is the `NudgeContext` ({ tool, orgBlocks })
// each ctx wiring produces:
//   - MCP   (mcp/tools.ts:308-317): toolName = spec.name, getOrgBlocksForNudge
//   - React (agent/tools.ts:360-406, buildAgentCtx): toolName, getOrgBlocksForNudge
//
// Both feed `{ tool: ctx.toolName, orgBlocks }` into `formatFullDocState`
// (agent/tool-specs.ts:396-408). So "both surfaces see the block" reduces to:
// the lens block is `target:{phase:'specify'}` (phase-scoped, tool-agnostic), and
// `formatFullDocState` for a specify-phase spec emits it regardless of which tool
// name the surface supplies. We exercise the real `formatFullDocState` with
// the NudgeContext each surface produces and assert the lens prose is present
// in BOTH footers.
//
// We also assert the block is `shared_nudge` (not `react_only`): it rides the
// nudge channel, so it needs NO React system-prompt wiring.

import { describe, it, expect } from "vitest";
import { tagAc } from "@memex-ai-ac/vitest";
import { formatFullDocState } from "./formatters.js";
import { BASE_SCAFFOLD } from "@memex/shared";
import type { Doc, DocSection } from "../db/schema.js";

const AC_13 = "mindset-prod/memex-building-itself/specs/spec-106/acs/ac-13";

const baseDate = new Date("2026-05-31T12:00:00Z");

// A specify-phase Spec — the phase that carries the lens-shape GuidanceBlock.
function makePlanSpec(): Doc & { sections: DocSection[] } {
  return {
    id: "spec-uuid-106",
    memexId: "test-memex",
    handle: "spec-106",
    title: "Some Spec",
    docType: "spec",
    status: "specify",
    parentDocId: null,
    createdByUserId: null,
    createdAt: baseDate,
    statusChangedAt: baseDate,
    archivedAt: null,
    pausedAt: null,
    narrativeLastConsolidatedAt: null,
    isDemo: false,
    sections: [
      {
        id: "section-uuid-1",
        docId: "spec-uuid-106",
        sectionType: "overview",
        title: "Overview",
        description: null,
        content: "Why this work exists.",
        seq: 1,
        status: "active",
        previousStatus: null,
        createdAt: baseDate,
        updatedAt: baseDate,
      } as DocSection,
    ],
  };
}

// The lens block as authored in BASE_SCAFFOLD. We assert against the actual
// data, not a hand-copied string, so a future re-word of the block doesn't
// silently desync this test from the source of truth.
const LENS_BLOCK = BASE_SCAFFOLD.promptBlocks.find(
  (b) => b.id === "spec-shape-lenses",
);

// A short, load-bearing slice of the lens prose — used as the cross-surface
// presence probe. (We also assert the full block text below.)
const LENS_PROBE = "Spec shape — propose the fitting anatomy";

describe("spec-106 t-3 ac-13: lens-shape GuidanceBlock reaches both surfaces' toNudge footers", () => {
  it("the lens block exists in BASE_SCAFFOLD and is `shared_nudge` (no React system-prompt wiring)", () => {
    tagAc(AC_13);

    expect(
      LENS_BLOCK,
      "BASE_SCAFFOLD must carry a prompt block with id `spec-shape-lenses`",
    ).toBeDefined();
    // shared_nudge — rides the nudge channel to BOTH agents; NOT a react_only
    // PromptBlock that would need separate React system-prompt assembly.
    expect(LENS_BLOCK!.surface).toBe("shared_nudge");

    // It is targeted at specify (and at create_doc for Spec birth) in baseGuidance.
    const specifyTargeted = BASE_SCAFFOLD.baseGuidance.find(
      (g) =>
        g.source === "base" &&
        g.target.phase === "specify" &&
        g.target.tool === undefined &&
        g.text === LENS_BLOCK!.text,
    );
    expect(
      specifyTargeted,
      "lens block must be a base GuidanceBlock targeting phase=specify",
    ).toBeDefined();
  });

  // The MCP surface wires ctx.toolName = the dispatching tool name. At Spec
  // birth that's `create_doc`; on a section edit it's `update_section`. The
  // React executor (buildAgentCtx) wires it identically. We model BOTH
  // surfaces by the NudgeContext each produces and run the SAME
  // formatFullDocState path.
  const SURFACES: { name: string; nudge: { tool?: string } }[] = [
    // MCP coding agent dispatching create_doc (Spec birth).
    { name: "MCP (create_doc)", nudge: { tool: "create_doc" } },
    // MCP coding agent dispatching update_section in specify.
    { name: "MCP (update_section)", nudge: { tool: "update_section" } },
    // React doc-chat authoring agent — same ctx shape, different tool name.
    { name: "React (update_section)", nudge: { tool: "update_section" } },
    // React doc-chat with no specific tool name (ctx.toolName undefined).
    { name: "React (no tool)", nudge: {} },
  ];

  for (const surface of SURFACES) {
    it(`lens guidance is present in the specify-phase footer for ${surface.name}`, () => {
      tagAc(AC_13);
      expect(LENS_BLOCK).toBeDefined();

      const spec = makePlanSpec();
      const out = formatFullDocState(
        spec,
        [],
        [],
        undefined,
        undefined,
        undefined,
        surface.nudge,
      );

      // Probe slice present...
      expect(
        out,
        `lens probe missing from ${surface.name} footer`,
      ).toContain(LENS_PROBE);
      // ...and the full block text present, byte-for-byte from BASE_SCAFFOLD.
      expect(
        out,
        `full lens block text missing from ${surface.name} footer`,
      ).toContain(LENS_BLOCK!.text);
    });
  }

  it("both surfaces produce the SAME lens guidance text (phase-scoped, tool-agnostic)", () => {
    tagAc(AC_13);
    expect(LENS_BLOCK).toBeDefined();

    const spec = makePlanSpec();
    // MCP ctx wiring (create_doc at Spec birth).
    const mcpFooter = formatFullDocState(
      spec,
      [],
      [],
      undefined,
      undefined,
      undefined,
      { tool: "create_doc" },
    );
    // React ctx wiring (doc-chat, e.g. update_section).
    const reactFooter = formatFullDocState(
      spec,
      [],
      [],
      undefined,
      undefined,
      undefined,
      { tool: "update_section" },
    );

    // The lens block is `target:{phase:'specify'}` — tool-agnostic — so the SAME
    // block text appears in both, proving the spec-68 dec-9 parity guarantee
    // for this block: it reaches the MCP agent AND the React doc-chat agent
    // via the one shared toNudge composition, with no React-only wiring.
    expect(mcpFooter).toContain(LENS_BLOCK!.text);
    expect(reactFooter).toContain(LENS_BLOCK!.text);
  });
});
