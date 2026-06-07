// b-33 t-5 / b-68 t-7: parser + merge coverage for per-phase MCP description
// overrides. Smoke check at the bottom asserts the current (empty) state
// results in zero behavioural change vs. the base tool catalogue.
//
// b-68 t-7 retired the `agent/phases/<phase>/mcp-descriptions.md` files;
// `PHASE_DESCRIPTIONS` now collapses to `{}` per phase (the comment-only
// stubs always parsed to `{}` — same shape, no behavioural difference).

import { access } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import { z } from "zod";
import {
  parsePhaseDescriptions,
  mergeDescriptions,
  applyPhaseDescriptionOverrides,
  PHASE_DESCRIPTIONS,
} from "./phase-descriptions.js";
import { toolSpecs, type ToolSpec } from "../agent/tool-specs.js";
import { toolManifest } from "@memex/shared";
import { tagAc } from "@memex-ai-ac/vitest";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PHASES_DIR = resolve(__dirname, "..", "agent", "phases");

// Minimal fake spec — `mergeDescriptions` only reads `name` and `description`,
// but ToolSpec requires the full shape. The handler / schema / annotations are
// unused for these tests.
function fakeSpec(name: string, description: string): ToolSpec {
  return {
    name,
    description,
    schema: { x: z.string().optional() },
    annotations: { title: name, readOnlyHint: true, destructiveHint: false },
    handler: async () => "noop",
  };
}

describe("parsePhaseDescriptions", () => {
  it("returns {} for an empty file", () => {
    expect(parsePhaseDescriptions("")).toEqual({});
    expect(parsePhaseDescriptions("   \n\n   ")).toEqual({});
  });

  it("returns {} for a comment-only file (current stub shape)", () => {
    const md = "<!-- per-phase tool description overrides go here -->\n";
    expect(parsePhaseDescriptions(md)).toEqual({});
  });

  it("picks up a single override", () => {
    const md = [
      "## create_task",
      "Replacement description for create_task in this phase.",
      "",
    ].join("\n");
    expect(parsePhaseDescriptions(md)).toEqual({
      create_task: "Replacement description for create_task in this phase.",
    });
  });

  it("picks up multiple overrides separated by headers", () => {
    const md = [
      "<!-- top-of-file comment -->",
      "",
      "## create_task",
      "Hidden in specify; use create_decision instead.",
      "",
      "## update_doc",
      "Multi-line body.",
      "Second line of update_doc override.",
      "",
      "## resolve_decision",
      "Resolve a decision with an explanation.",
    ].join("\n");
    expect(parsePhaseDescriptions(md)).toEqual({
      create_task: "Hidden in specify; use create_decision instead.",
      update_doc: "Multi-line body.\nSecond line of update_doc override.",
      resolve_decision: "Resolve a decision with an explanation.",
    });
  });

  it("ignores top-level prose outside any header", () => {
    const md = [
      "Some stray prose at the top of the file.",
      "",
      "## list_docs",
      "Override body.",
    ].join("\n");
    expect(parsePhaseDescriptions(md)).toEqual({
      list_docs: "Override body.",
    });
  });

  it("drops headers with empty bodies (treats them as structural placeholders)", () => {
    const md = ["## create_task", "", "## update_doc", "Real override."].join("\n");
    expect(parsePhaseDescriptions(md)).toEqual({
      update_doc: "Real override.",
    });
  });
});

describe("mergeDescriptions", () => {
  const base: ToolSpec[] = [
    fakeSpec("alpha", "alpha base"),
    fakeSpec("beta", "beta base"),
    fakeSpec("gamma", "gamma base"),
  ];

  it("returns a deeply-equal array when overrides is empty", () => {
    const out = mergeDescriptions(base, {});
    expect(out).toEqual(base);
  });

  it("does not mutate the input array or specs", () => {
    const before = base.map((s) => ({ ...s }));
    const out = mergeDescriptions(base, { alpha: "alpha NEW" });
    // base is unchanged
    expect(base.map((s) => ({ name: s.name, description: s.description }))).toEqual(
      before.map((s) => ({ name: s.name, description: s.description })),
    );
    // out is a fresh array
    expect(out).not.toBe(base);
    // The overridden spec is a fresh object — original spec reference still
    // points to the original description.
    expect(out[0]).not.toBe(base[0]);
    expect(base[0].description).toBe("alpha base");
  });

  it("replaces only the named tools, leaving others identical", () => {
    const out = mergeDescriptions(base, {
      alpha: "alpha NEW",
      gamma: "gamma NEW",
    });
    expect(out.map((s) => ({ name: s.name, description: s.description }))).toEqual([
      { name: "alpha", description: "alpha NEW" },
      { name: "beta", description: "beta base" },
      { name: "gamma", description: "gamma NEW" },
    ]);
    // Beta is the same object reference (no clone for unaffected tools).
    expect(out[1]).toBe(base[1]);
  });

  it("ignores overrides for tools not in the base set (forwards-compat)", () => {
    const out = mergeDescriptions(base, {
      alpha: "alpha NEW",
      not_a_real_tool: "should be ignored",
    });
    expect(out.map((s) => s.description)).toEqual([
      "alpha NEW",
      "beta base",
      "gamma base",
    ]);
  });
});

describe("applyPhaseDescriptionOverrides", () => {
  const base: ToolSpec[] = [
    fakeSpec("alpha", "alpha base"),
    fakeSpec("beta", "beta base"),
  ];

  it("is a no-op when phase is undefined (current MCP registration site)", () => {
    const out = applyPhaseDescriptionOverrides(base, undefined);
    expect(out).toBe(base);
  });

  it("applies the phase's overrides when phase is provided", () => {
    // The smoke test below proves the stubs are empty, so we go behind the
    // module by injecting a known override on the live phase map. We restore
    // after to keep tests order-independent.
    const original = { ...PHASE_DESCRIPTIONS.specify };
    try {
      PHASE_DESCRIPTIONS.specify = { alpha: "alpha PHASE-SPECIFY" };
      const out = applyPhaseDescriptionOverrides(base, "specify");
      expect(out.map((s) => s.description)).toEqual(["alpha PHASE-SPECIFY", "beta base"]);
    } finally {
      PHASE_DESCRIPTIONS.specify = original;
    }
  });
});

describe("PHASE_DESCRIPTIONS (current empty state)", () => {
  it("every phase resolves to an empty override map (b-68 t-7: previously parsed from `phases/<p>/mcp-descriptions.md`, now sourced from BASE_SCAFFOLD)", () => {
    for (const phase of ["draft", "specify", "build", "verify", "done"] as const) {
      expect(PHASE_DESCRIPTIONS[phase]).toEqual({});
    }
  });

  it("draft and specify share the same override map (the two phases are functionally identical for the agent)", () => {
    expect(PHASE_DESCRIPTIONS.draft).toEqual(PHASE_DESCRIPTIONS.specify);
  });
});

describe("smoke: MCP tool descriptions are unchanged with current overrides", () => {
  it("applyPhaseDescriptionOverrides(specs, <each phase>) yields the same descriptions as base", () => {
    const baseDescriptions = toolSpecs.map((s) => ({
      name: s.name,
      description: s.description,
    }));
    for (const phase of ["draft", "specify", "build", "verify", "done"] as const) {
      const merged = applyPhaseDescriptionOverrides(toolSpecs, phase);
      expect(merged.map((s) => ({ name: s.name, description: s.description }))).toEqual(
        baseDescriptions,
      );
    }
  });
});

// ════════════════════════════════════════════════════════════════════
// b-68 t-7 AC-tagged guards
// ════════════════════════════════════════════════════════════════════

describe("b-68 t-7 ac-23: mcp-descriptions.md files are retired", () => {
  it("every `phases/<phase>/mcp-descriptions.md` file no longer exists on disk", async () => {
    tagAc("mindset-prod/memex-building-itself/specs/spec-68/acs/ac-23");
    for (const folder of ["specify", "build", "verify", "done"] as const) {
      const path = resolve(PHASES_DIR, folder, "mcp-descriptions.md");
      await expect(access(path)).rejects.toThrow();
    }
  });

  it("toolManifest entries carry no phase-conditional summary / args content (pinning regression — manifest is phase-agnostic)", () => {
    tagAc("mindset-prod/memex-building-itself/specs/spec-68/acs/ac-23");
    // ToolManifestEntry shape carries `{name, summary, args, group,
    // readOnlyHint, trafficClass, autoAssignExempt?}`. None of those fields
    // branch on Spec phase — they're authored once and shipped to every
    // surface uniformly. This test pins that contract so a future change
    // (e.g. adding a `summaryByPhase`) is flagged as drift from b-68 dec-6
    // ("one model, many projections" — phase-specific tool descriptions
    // arrive as scaffold-data GuidanceBlocks, NOT manifest entries).
    // (spec-156 ac-25 added the phase-agnostic `readOnlyHint`; spec-189
    // dec-4 added the equally phase-agnostic `trafficClass` +
    // `autoAssignExempt` — the CLASSIFICATION is static per tool; the
    // phase-dependent behaviour lives in nextPhaseForTraffic, not here.)
    for (const entry of toolManifest) {
      expect(entry).toEqual({
        name: expect.any(String),
        summary: expect.any(String),
        args: expect.any(String),
        group: expect.any(String),
        readOnlyHint: expect.any(Boolean),
        trafficClass:
          entry.trafficClass === null
            ? null
            : expect.stringMatching(/^(specify|build|verify)$/),
        ...(entry.autoAssignExempt !== undefined
          ? { autoAssignExempt: expect.any(Boolean) }
          : {}),
      });
    }
  });
});
