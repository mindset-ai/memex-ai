// spec-360 t-2 / t-3 — the scaffold assistant's grounding + change validator.
//
// **ac-5** — the grounding the assistant is fed is DERIVED from the same
// projections the runtime uses (toPhaseGuidance / toRubric) and faithfully
// carries the org's live additions WITH their ids, so the assistant's claims
// cannot drift from what the agents actually receive.
//
// **ac-12** — validate-and-pushback (dec-9): an impossible target is refused,
// an incoherent request is pushed back with a suggestion, a coherent one is OK.

import { describe, it, expect } from "vitest";
import { tagAc } from "@memex-ai-ac/vitest";
import {
  BASE_SCAFFOLD,
  SCAFFOLD_AGENT_GUIDANCE,
  scaffoldReviewEditSeed,
} from "./scaffold-data.js";
import {
  toScaffoldGrounding,
  validateScaffoldChange,
  encodeScaffoldProposal,
  parseScaffoldProposal,
  type ScaffoldProposal,
} from "./scaffold-grounding.js";
import { toPhaseGuidance, toRubric } from "./scaffold-model.js";
import type { GuidanceBlock } from "./scaffold-model.js";

const AC = (n: number) =>
  `mindset-prod/memex-building-itself/specs/spec-360/acs/ac-${n}`;

// A representative org addition with an id, scoped to a real circumstance.
const ORG_BLOCK: GuidanceBlock & { id: string } = {
  kind: "guidance_block",
  id: "org-block-abc",
  source: "org",
  target: { tool: "create_task", phase: "build" },
  text: "Every build task must carry at least one acceptance criterion.",
  enabled: true,
  order: 0,
  rationale: "org house rule",
};

describe("spec-360 t-2: grounding is derived from the runtime projections (ac-5)", () => {
  it("embeds the real composed phase guidance for each phase", () => {
    tagAc(AC(5));
    const grounding = toScaffoldGrounding(BASE_SCAFFOLD, []);
    for (const phase of ["specify", "build", "verify"] as const) {
      const composed = toPhaseGuidance(BASE_SCAFFOLD, phase);
      if (composed.length > 0) {
        expect(
          grounding,
          `grounding must contain the toPhaseGuidance(${phase}) projection verbatim`,
        ).toContain(composed);
      }
    }
  });

  it("embeds the real gate rubric for each forward transition", () => {
    tagAc(AC(5));
    const grounding = toScaffoldGrounding(BASE_SCAFFOLD, []);
    for (const t of BASE_SCAFFOLD.transitions) {
      const rubric = toRubric({ dataset: BASE_SCAFFOLD, transition: t.transition });
      if (rubric.length > 0) {
        expect(grounding).toContain(rubric);
      }
    }
  });

  it("carries the org's live additions WITH their ids and text", () => {
    tagAc(AC(5));
    const grounding = toScaffoldGrounding(BASE_SCAFFOLD, [ORG_BLOCK]);
    expect(grounding, "the block id must be addressable for edit/disable/delete").toContain(
      "org-block-abc",
    );
    expect(grounding).toContain(ORG_BLOCK.text);
    // and it states where the addition lands, in plain language
    expect(grounding).toMatch(/create_task/);
  });

  it("never claims the org has additions when it has none", () => {
    tagAc(AC(5));
    const grounding = toScaffoldGrounding(BASE_SCAFFOLD, []);
    expect(grounding).toMatch(/None yet|no guidance/i);
  });

  it("stays bounded — it does NOT re-emit phase guidance per tool×phase (ac-10 fits the context window)", () => {
    tagAc(AC(10));
    // Regression for the 697k-token blowup: an earlier version composed toNudge
    // for every tool in every phase, re-emitting the whole phase guidance ~150×.
    // The grounding is one cached system block — it must comfortably fit. A
    // generous ceiling (~25k tokens) catches a regression without being brittle.
    const grounding = toScaffoldGrounding(BASE_SCAFFOLD, []);
    expect(
      grounding.length,
      `grounding is ${grounding.length} chars (~${Math.round(grounding.length / 4)} tokens) — too large for a system block`,
    ).toBeLessThan(100_000);
  });
});

describe("spec-360 t-3: validate-and-pushback (ac-12 / dec-9)", () => {
  it("HARD-REFUSES an impossible target — a tool blocked in the named phase", () => {
    tagAc(AC(12));
    // create_task is blocked in specify (tasks are build-only).
    const specify = BASE_SCAFFOLD.phases.find((p) => p.phase === "specify");
    expect(specify?.allowance.blocked).toContain("create_task");
    const v = validateScaffoldChange(
      BASE_SCAFFOLD,
      { tool: "create_task", phase: "specify" },
      "Always attach an AC.",
    );
    expect(v.outcome).toBe("impossible");
    if (v.outcome === "impossible") expect(v.reason).toMatch(/does not run|blocked/i);
  });

  it("HARD-REFUSES an impossible target — a tool that does not exist", () => {
    tagAc(AC(12));
    const v = validateScaffoldChange(
      BASE_SCAFFOLD,
      { tool: "no_such_tool_xyz" },
      "do something",
    );
    expect(v.outcome).toBe("impossible");
  });

  it("PUSHES BACK on an untargeted org-global (dilutes every nudge) with a suggestion", () => {
    tagAc(AC(12));
    const v = validateScaffoldChange(BASE_SCAFFOLD, {}, "Be thorough.");
    expect(v.outcome).toBe("incoherent");
    if (v.outcome === "incoherent") {
      expect(v.reason).toMatch(/dilut|every nudge/i);
      expect(v.suggestion.length).toBeGreaterThan(0);
    }
  });

  it("PUSHES BACK on empty text", () => {
    tagAc(AC(12));
    const v = validateScaffoldChange(BASE_SCAFFOLD, { phase: "build" }, "   ");
    expect(v.outcome).toBe("incoherent");
  });

  it("PUSHES BACK on a verbatim duplicate of base guidance at the same target", () => {
    tagAc(AC(12));
    // Pick a TARGETED base block — an untargeted one would trip the org-global
    // check first (that is the correct precedence; this test isolates the dup path).
    const base = BASE_SCAFFOLD.baseGuidance.find(
      (b) =>
        b.source === "base" &&
        b.text.trim().length > 0 &&
        (b.target.phase !== undefined ||
          b.target.tool !== undefined ||
          b.target.transition !== undefined ||
          b.target.button !== undefined),
    );
    expect(base, "fixture needs at least one targeted base guidance block").toBeDefined();
    const v = validateScaffoldChange(BASE_SCAFFOLD, base!.target, base!.text);
    expect(v.outcome).toBe("incoherent");
    if (v.outcome === "incoherent") expect(v.reason).toMatch(/already|duplicat|repeat/i);
  });

  it("accepts a COHERENT, well-targeted, novel addition", () => {
    tagAc(AC(12));
    const v = validateScaffoldChange(
      BASE_SCAFFOLD,
      { tool: "create_task", phase: "build" },
      "Every build task must carry at least one acceptance criterion.",
    );
    expect(v.outcome).toBe("ok");
  });
});

// spec-360 issue-5 / issue-6 / issue-7 — the SCAFFOLD_AGENT_GUIDANCE prose
// steers the assistant to the display-only UI tools: navigate to show WHERE a
// circumstance lives, quote to show its exact TEXT (verbatim, never inline "…").
describe("spec-360: SCAFFOLD_AGENT_GUIDANCE steers the navigate/quote UI tools (ac-1)", () => {
  const text = SCAFFOLD_AGENT_GUIDANCE.text;

  it("tells the agent to navigate the on-screen scaffold with render_navigate (issue-6)", () => {
    tagAc(AC(1));
    expect(text).toContain("render_navigate");
    // navigate is the FIRST move / default for "where/what applies here".
    expect(text).toMatch(/FIRST move|NAVIGATE them to it/);
  });

  it("tells the agent to render verbatim guidance text with render_quote (issue-5)", () => {
    tagAc(AC(1));
    expect(text).toContain("render_quote");
    // verbatim, with a source label, NEVER inline quotation marks.
    expect(text).toMatch(/verbatim/);
    expect(text).toMatch(/source/);
    expect(text).toMatch(/NEVER inline quotation marks/);
  });

  it("covers the 'would-add / not-an-admin → still a quote block' case (issue-7)", () => {
    tagAc(AC(1));
    // The literal text of a proposal you'd make is STILL a quote block, even
    // when proposing isn't possible because the viewer is not an admin.
    expect(text).toMatch(/would propose|would add|I would add/);
    expect(text).toMatch(/even when you cannot actually propose it/);
    expect(text).toMatch(/not an admin/i);
  });

  it("separates navigate (WHERE) from quote (exact TEXT) (issue-6 / issue-7)", () => {
    tagAc(AC(1));
    expect(text).toMatch(/Navigate to show WHERE/);
    expect(text).toMatch(/quote to show its exact TEXT/);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// spec-360 issue-11 — per-Memex vs org-wide scope rides the proposal.
// The `scope` field round-trips through the JSON encode/parse contract so the
// server (emit) and the UI (parse + approve) agree on which scope the admin chose.
// ──────────────────────────────────────────────────────────────────────────
describe("spec-360 issue-11: ScaffoldProposal.scope round-trips through encode/parse (ac-2)", () => {
  it("encodes + parses a 'memex'-scoped add unchanged", () => {
    tagAc(AC(2));
    const proposal: ScaffoldProposal = {
      operation: "add",
      target: { tool: "create_task", phase: "build" },
      text: "This project always pairs an AC with a build task.",
      rationale: "house rule",
      scope: "memex",
      summary: "Add org guidance when create_task runs during build (this Memex only).",
    };
    const parsed = parseScaffoldProposal(encodeScaffoldProposal(proposal));
    expect(parsed).not.toBeNull();
    expect(parsed!.scope).toBe("memex");
    expect(parsed).toEqual(proposal);
  });

  it("encodes + parses an 'org'-scoped add unchanged", () => {
    tagAc(AC(2));
    const proposal: ScaffoldProposal = {
      operation: "add",
      target: { phase: "build" },
      text: "Org-wide policy text.",
      rationale: "org policy",
      scope: "org",
      summary: "Add org guidance during build.",
    };
    const parsed = parseScaffoldProposal(encodeScaffoldProposal(proposal));
    expect(parsed!.scope).toBe("org");
  });

  it("a proposal with no scope round-trips as undefined (the org-wide default)", () => {
    tagAc(AC(2));
    const proposal: ScaffoldProposal = {
      operation: "add",
      target: { phase: "build" },
      text: "Some guidance.",
      rationale: "why",
      summary: "Add org guidance during build.",
    };
    const parsed = parseScaffoldProposal(encodeScaffoldProposal(proposal));
    expect(parsed!.scope).toBeUndefined();
  });
});

// ──────────────────────────────────────────────────────────────────────────
// spec-360 issue-10 — review-on-manual-edit. When an admin makes a MANUAL
// inline add/edit (not through the propose flow), the surface fires this seed so
// the assistant ASSESSES the change rather than leaving a weak/impossible rule
// unreviewed. The block is already SAVED + LIVE — the assistant must not re-create it.
// ──────────────────────────────────────────────────────────────────────────
describe("spec-360 issue-10: scaffoldReviewEditSeed asks for an assessment of a saved block (ac-12)", () => {
  it("includes the operation, the target label, and the verbatim text", () => {
    tagAc(AC(12));
    const seed = scaffoldReviewEditSeed({
      operation: "added",
      targetLabel: "during the build phase",
      text: "Every build task carries an acceptance criterion.",
    });
    expect(seed).toContain("added");
    expect(seed).toContain("during the build phase");
    expect(seed).toContain("Every build task carries an acceptance criterion.");
  });

  it("tells the assistant the block is already SAVED and LIVE — don't re-create it", () => {
    tagAc(AC(12));
    const seed = scaffoldReviewEditSeed({
      operation: "edited",
      targetLabel: "during the verify phase",
      text: "Walk every AC against the running system.",
    });
    expect(seed).toMatch(/SAVED and LIVE/);
    expect(seed).toMatch(/don't try to re-create it|don't.*re-create/i);
  });

  it("asks the assistant to assess BOTH possible AND effective, and to offer an EDIT if weak", () => {
    tagAc(AC(12));
    const seed = scaffoldReviewEditSeed({
      operation: "added",
      targetLabel: "during the build phase",
      text: "Be thorough.",
    });
    expect(seed).toMatch(/POSSIBLE/);
    expect(seed).toMatch(/EFFECTIVE/);
    // weak/impossible → offer to propose an EDIT to the saved block.
    expect(seed).toMatch(/propose an EDIT/);
  });

  it("omits the 'it applies …' clause when no target label is given", () => {
    tagAc(AC(12));
    const seed = scaffoldReviewEditSeed({
      operation: "added",
      targetLabel: "",
      text: "Some text.",
    });
    expect(seed).not.toContain("it applies");
    expect(seed).toContain("Some text.");
  });
});

// ──────────────────────────────────────────────────────────────────────────
// spec-360 issue-13 — surroundings-awareness + copyable handoff. The agent must
// KNOW its limits (only propose_scaffold_change; never create_doc), ground
// itself with search_memex/get_doc, and hand off a copyable prompt when a
// Standard or new Spec is needed rather than improvising.
// ──────────────────────────────────────────────────────────────────────────
describe("spec-360 issue-13: SCAFFOLD_AGENT_GUIDANCE states the agent's limits + handoff (ac-1)", () => {
  const text = SCAFFOLD_AGENT_GUIDANCE.text;

  it("forbids create_doc and any tool beyond the scaffold subset", () => {
    tagAc(AC(1));
    expect(text).toMatch(/never call `?create_doc`?/i);
    // its ONLY authoring power is propose_scaffold_change.
    expect(text).toContain("propose_scaffold_change");
    expect(text).toMatch(/ONLY authoring power/i);
  });

  it("tells the agent to ground itself with search_memex and get_doc (its surroundings)", () => {
    tagAc(AC(1));
    expect(text).toContain("search_memex");
    expect(text).toContain("get_doc");
    // it is aware of Standards, Drift, and Specs around it.
    expect(text).toMatch(/Standards/);
    expect(text).toMatch(/Specs/);
  });

  it("instructs a copyable render_quote handoff when a Standard/Spec is needed", () => {
    tagAc(AC(1));
    expect(text).toContain("render_quote");
    expect(text).toMatch(/copyable: true/);
    // hand off to the Standards agent / the New Spec flow.
    expect(text).toMatch(/Standards agent/);
    expect(text).toMatch(/New Spec flow/);
  });
});
