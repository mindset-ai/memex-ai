// spec-464: the phase gate — ahead-of-phase refusal, in-phase pass-through,
// behind-phase allowance, done-reopen, and the create_ac kind branch.
//
// enforcePhaseGate is pure given (manifest, resolveRef, catalog): it never
// mutates and reads the Spec's phase through ctx.resolveRef. So the whole matrix
// is exercised here with a stub resolveRef and no database — one test per gated
// cell, tagged to its AC. The teaching PROSE it composes is asserted to come
// from PHASE_GATING_CATALOG (scaffold-data.ts), not inline strings (ac-24).

import { describe, it, expect } from "vitest";
import { tagAc } from "@memex-ai-ac/vitest";
import { PHASE_GATING_CATALOG, type SpecPhase } from "@memex/shared";
import { enforcePhaseGate } from "./phase-gate.js";
import type { ToolCtx } from "../agent/handlers/shared.js";

const AC = (n: number) =>
  `mindset-prod/memex-building-itself/specs/spec-464/acs/ac-${n}`;

const REF = "mindset-prod/memex-building-itself/specs/spec-1";

// A ctx whose resolveRef reports a Spec sitting in `status`. Only doc.docType +
// doc.status are read by the gate, so the rest is a minimal stub.
function ctxAt(
  status: SpecPhase,
  channel: "mcp" | "in_app_agent" = "mcp",
): ToolCtx {
  return {
    channel,
    userId: "u1",
    resolveRef: async () => ({ doc: { docType: "spec", status } }),
  } as unknown as ToolCtx;
}

// Convenience: run the gate for `tool` on a Spec at `status`.
function gate(
  tool: string,
  status: SpecPhase,
  input: Record<string, unknown> = {},
  channel: "mcp" | "in_app_agent" = "mcp",
): Promise<string | null> {
  return enforcePhaseGate(tool, { ref: REF, ...input }, ctxAt(status, channel));
}

// Capture the thrown ValidationError message (or null if it didn't throw).
async function refusalMessage(
  tool: string,
  status: SpecPhase,
  input: Record<string, unknown> = {},
  channel: "mcp" | "in_app_agent" = "mcp",
): Promise<string | null> {
  try {
    await gate(tool, status, input, channel);
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

const TASK_TOOLS = [
  "create_task",
  "update_task",
  "delete_task",
  "convert_issue_to_task",
  "kick_task_to_issue",
];

describe("spec-464 phase gate — ahead-of-phase refusal (ac-2, ac-7, ac-8)", () => {
  it("an ahead-of-phase mcp call is refused with the teaching string and no write; the gate is the seam's decision (ac-2)", async () => {
    tagAc(AC(2));
    // create_task is home 'build'; on a specify Spec that is ahead → refused.
    await expect(gate("create_task", "specify")).rejects.toThrow();
    // in_app_agent is refused identically (dec-23); rest_ui never routes through
    // this seam (channel is typed mcp|in_app_agent), so it is structurally exempt.
    await expect(gate("create_task", "specify", {}, "in_app_agent")).rejects.toThrow();
  });

  it("task/bridge tools on a DRAFT Spec are refused with the draft task message (ac-7)", async () => {
    tagAc(AC(7));
    for (const tool of TASK_TOOLS) {
      expect(await refusalMessage(tool, "draft")).toBe(
        PHASE_GATING_CATALOG.refusals["task:draft"],
      );
    }
  });

  it("task/bridge tools on a SPECIFY Spec are refused with the 'reframe as a decision' message (ac-8)", async () => {
    tagAc(AC(8));
    for (const tool of TASK_TOOLS) {
      expect(await refusalMessage(tool, "specify")).toBe(
        PHASE_GATING_CATALOG.refusals["task:specify"],
      );
    }
  });
});

describe("spec-464 phase gate — in-phase & behind pass-through (ac-4, ac-6, ac-9, ac-21)", () => {
  it("decision tools on a SPECIFY Spec run with no out-of-phase guidance (ac-4)", async () => {
    tagAc(AC(4));
    for (const tool of [
      "create_decision",
      "update_decision",
      "resolve_decision",
      "delete_decision",
      "approve_candidate",
      "reject_candidate",
    ]) {
      expect(await gate(tool, "specify")).toBeNull();
    }
  });

  it("scope-AC tools on a SPECIFY Spec run with no out-of-phase guidance (ac-6)", async () => {
    tagAc(AC(6));
    expect(await gate("create_ac", "specify", { kind: "scope" })).toBeNull();
    for (const tool of ["update_ac", "delete_ac", "link_ac_to_decision"]) {
      expect(await gate(tool, "specify")).toBeNull();
    }
  });

  it("task/bridge tools on a BUILD Spec run with no out-of-phase guidance (ac-9)", async () => {
    tagAc(AC(9));
    for (const tool of TASK_TOOLS) {
      expect(await gate(tool, "build")).toBeNull();
    }
  });

  it("a behind-phase call succeeds with at most an advisory line, never a refusal, no phase change (ac-21)", async () => {
    tagAc(AC(21));
    // resolve_decision (home specify) on a build Spec is behind-phase.
    const note = await gate("resolve_decision", "build");
    expect(note).toBe(PHASE_GATING_CATALOG.behindAdvisory.build);
    // It is a note, not a refusal — the call did not throw.
    expect(note).not.toContain("⛔");
  });
});

describe("spec-464 phase gate — implementation-AC creation & emission tools (ac-10, ac-11, ac-12, ac-13)", () => {
  it("create_ac(kind:implementation) on DRAFT is allowed with the publish nudge, not refused; emission tools ungated (ac-10)", async () => {
    tagAc(AC(10));
    // dec-10 (revised, Option A): impl ACs are authored in specify like decisions
    // — the specify→build readiness gate requires them before build, so they are
    // never hard-refused ahead of build. On a draft they carry the publish nudge.
    expect(await gate("create_ac", "draft", { kind: "implementation" })).toBe(
      PHASE_GATING_CATALOG.draftPlanningNudge,
    );
    expect(await gate("provision_ac_emission", "draft")).toBeNull();
    expect(await gate("discontinue_test_events", "draft")).toBeNull();
  });

  it("create_ac(kind:implementation) on SPECIFY is in-phase (allowed, no guidance); emission tools ungated (ac-11)", async () => {
    tagAc(AC(11));
    expect(await gate("create_ac", "specify", { kind: "implementation" })).toBeNull();
    expect(await gate("provision_ac_emission", "specify")).toBeNull();
    expect(await gate("discontinue_test_events", "specify")).toBeNull();
  });

  it("create_ac(kind:implementation) + emission tools run on a BUILD Spec (ac-12)", async () => {
    tagAc(AC(12));
    expect(await gate("create_ac", "build", { kind: "implementation" })).toBeNull();
    expect(await gate("provision_ac_emission", "build")).toBeNull();
  });

  it("create_ac(kind:implementation) + emission tools run on a VERIFY Spec with no guidance (ac-13)", async () => {
    tagAc(AC(13));
    expect(await gate("create_ac", "verify", { kind: "implementation" })).toBeNull();
    expect(await gate("provision_ac_emission", "verify")).toBeNull();
  });
});

describe("spec-464 phase gate — write_qa_report (ac-14, ac-15, ac-16, ac-17)", () => {
  it("write_qa_report refused on DRAFT (ac-14)", async () => {
    tagAc(AC(14));
    expect(await refusalMessage("write_qa_report", "draft")).toBe(
      PHASE_GATING_CATALOG.refusals["qa_report:draft"],
    );
  });

  it("write_qa_report refused on SPECIFY (ac-15)", async () => {
    tagAc(AC(15));
    expect(await refusalMessage("write_qa_report", "specify")).toBe(
      PHASE_GATING_CATALOG.refusals["qa_report:specify"],
    );
  });

  it("write_qa_report runs on a BUILD Spec (ac-16)", async () => {
    tagAc(AC(16));
    expect(await gate("write_qa_report", "build")).toBeNull();
  });

  it("write_qa_report runs on a VERIFY Spec with NO out-of-phase guidance (ac-17)", async () => {
    tagAc(AC(17));
    expect(await gate("write_qa_report", "verify")).toBeNull();
  });
});

describe("spec-464 phase gate — never-gated tool families (ac-3, ac-5, ac-18, ac-19, ac-20)", () => {
  it("create_decision on a DRAFT Spec succeeds (no throw) and returns the publish nudge (ac-3)", async () => {
    tagAc(AC(3));
    expect(await gate("create_decision", "draft")).toBe(
      PHASE_GATING_CATALOG.draftPlanningNudge,
    );
  });

  it("create_ac(kind:scope) on a DRAFT Spec succeeds and returns the publish nudge (ac-5)", async () => {
    tagAc(AC(5));
    expect(await gate("create_ac", "draft", { kind: "scope" })).toBe(
      PHASE_GATING_CATALOG.draftPlanningNudge,
    );
  });

  it("section tools are never refused in any working phase (ac-18)", async () => {
    tagAc(AC(18));
    for (const phase of ["draft", "specify", "build", "verify"] as SpecPhase[]) {
      for (const tool of ["add_section", "update_section", "retitle_section", "delete_section"]) {
        expect(await gate(tool, phase)).toBeNull();
      }
    }
  });

  it("issue lifecycle runs in every phase with no phase change; convert/kick follow task rules (ac-19)", async () => {
    tagAc(AC(19));
    for (const tool of ["register_issue", "update_issue", "resolve_issue"]) {
      expect(await gate(tool, "specify")).toBeNull();
    }
    // convert_issue_to_task / kick_task_to_issue mint or destroy a TASK → task rules.
    await expect(gate("convert_issue_to_task", "specify")).rejects.toThrow();
    await expect(gate("kick_task_to_issue", "specify")).rejects.toThrow();
  });

  it("phase-control + cross-cutting tools run in every phase with no refusal (ac-20)", async () => {
    tagAc(AC(20));
    for (const phase of ["draft", "specify", "build", "verify"] as SpecPhase[]) {
      for (const tool of ["update_doc", "publish_spec", "assess_spec", "add_comment", "assign_spec"]) {
        expect(await gate(tool, phase)).toBeNull();
      }
    }
    // Read-only tools are never gated either.
    expect(await gate("get_doc", "draft")).toBeNull();
    expect(await gate("list_docs", "build")).toBeNull();
  });
});

describe("spec-464 phase gate — done-Spec reopen-first (ac-22)", () => {
  it("a spec-primitive mutation on a DONE Spec is refused reopen-first; issues + comments still run (ac-22)", async () => {
    tagAc(AC(22));
    // Primitives (decision, scope AC, task, section, qa report) → reopen-first.
    for (const [tool, input] of [
      ["create_decision", {}],
      ["create_ac", { kind: "scope" }],
      ["create_ac", { kind: "implementation" }],
      ["update_task", {}],
      ["update_section", {}],
      ["write_qa_report", {}],
    ] as Array<[string, Record<string, unknown>]>) {
      expect(await refusalMessage(tool, "done", input)).toBe(
        PHASE_GATING_CATALOG.doneReopen,
      );
    }
    // Issue + comment tools remain allowed on a done Spec.
    expect(await gate("register_issue", "done")).toBeNull();
    expect(await gate("resolve_issue", "done")).toBeNull();
    expect(await gate("add_comment", "done")).toBeNull();
  });
});

describe("spec-464 phase gate — both agent channels refused identically (ac-23)", () => {
  it("an ahead-of-phase in_app_agent call is refused identically to mcp; behind/cross-cutting in_app_agent calls succeed (ac-23)", async () => {
    tagAc(AC(23));
    const mcpMsg = await refusalMessage("create_task", "specify", {}, "mcp");
    const inAppMsg = await refusalMessage("create_task", "specify", {}, "in_app_agent");
    expect(inAppMsg).toBe(mcpMsg);
    expect(inAppMsg).toBe(PHASE_GATING_CATALOG.refusals["task:specify"]);
    // Behind + cross-cutting in_app_agent calls are not refused.
    expect(await gate("resolve_decision", "build", {}, "in_app_agent")).toBe(
      PHASE_GATING_CATALOG.behindAdvisory.build,
    );
    expect(await gate("add_comment", "specify", {}, "in_app_agent")).toBeNull();
  });
});

describe("spec-464 phase gate — teaching prose is sourced from the scaffold catalog (ac-24)", () => {
  it("the refusal the gate throws is composed from PHASE_GATING_CATALOG, not an inline string (ac-24)", async () => {
    tagAc(AC(24));
    // Byte-for-byte identity proves the gate reads the scaffold catalog as its
    // single teaching-prose source (dec-24): change the catalog string and the
    // refusal changes with no gate edit.
    expect(await refusalMessage("create_task", "specify")).toBe(
      PHASE_GATING_CATALOG.refusals["task:specify"],
    );
    expect(await refusalMessage("write_qa_report", "draft")).toBe(
      PHASE_GATING_CATALOG.refusals["qa_report:draft"],
    );
    expect(await refusalMessage("update_section", "done")).toBe(
      PHASE_GATING_CATALOG.doneReopen,
    );
  });
});
