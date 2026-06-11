// spec-249 — the live next-move line get_doc pushes onto a cold agent.
//
// composeNextMove is PURE (no DB, no clock): a deterministic projection of spec
// state. These unit tests pin the projection directly — every phase, the forward
// action keyed off the most pressing gap, and the live verbose-pointer gate.
//
// ac-1: terse get_doc ends with one synthesized line — phase + headline state +
//       the single next action.
// ac-2: the line is live — derived from state, changes as decisions resolve, ACs
//       get tested, tasks complete; no fixed advertisement text.
// ac-3: the verbose pointer appears only when there is material hidden state.

import { describe, it, expect } from "vitest";
import { tagAc } from "@memex-ai-ac/vitest";
import { composeNextMove, type NextMoveFacts } from "./tool-specs.js";

const AC = (n: number) =>
  `mindset-prod/memex-building-itself/specs/spec-249/acs/ac-${n}`;

const baseFacts = (over: Partial<NextMoveFacts> = {}): NextMoveFacts => ({
  handle: "spec-249",
  phase: "specify",
  openDecisions: [],
  resolvedDecisionsWithoutImplAc: [],
  implAcsActive: 0,
  scopeAcsActive: 0,
  untestedAcs: [],
  incompleteTasks: [],
  taskCount: 0,
  ...over,
});

describe("composeNextMove — one synthesized line (ac-1)", () => {
  it("reproduces the spec's worked example for specify", () => {
    tagAc(AC(1));
    const line = composeNextMove(
      baseFacts({
        phase: "specify",
        openDecisions: ["dec-1"],
        implAcsActive: 0,
      }),
    );
    expect(line).toBe(
      "spec-249 · specify · 1 open decision (dec-1), 0 implementation ACs. " +
        "Next: resolve dec-1, then give it an implementation AC. " +
        "(get_doc verbose for the full decision/task text.)",
    );
  });

  it("always leads with handle and phase", () => {
    tagAc(AC(1));
    for (const phase of ["draft", "specify", "build", "verify", "done"] as const) {
      const line = composeNextMove(baseFacts({ phase }));
      expect(line.startsWith(`spec-249 · ${phase} · `)).toBe(true);
      expect(line).toContain("Next: ");
      expect(line.trimEnd().endsWith(".") || line.includes("verbose")).toBe(true);
    }
  });
});

describe("composeNextMove — the action tracks the most pressing gap (ac-2)", () => {
  it("specify: open decision outranks an uncovered resolved one", () => {
    tagAc(AC(2));
    const line = composeNextMove(
      baseFacts({
        openDecisions: ["dec-2", "dec-3"],
        resolvedDecisionsWithoutImplAc: ["dec-1"],
        implAcsActive: 1,
      }),
    );
    expect(line).toContain("Next: resolve dec-2, then give it an implementation AC.");
  });

  it("specify: no open decisions but a resolved one lacks its implementation AC", () => {
    tagAc(AC(2));
    const line = composeNextMove(
      baseFacts({ resolvedDecisionsWithoutImplAc: ["dec-1"], implAcsActive: 0 }),
    );
    expect(line).toContain(
      "Next: give dec-1 an implementation AC (create_ac kind:implementation).",
    );
  });

  it("specify: decisions covered but no scope ACs yet → pin down done", () => {
    tagAc(AC(2));
    const line = composeNextMove(baseFacts({ implAcsActive: 2, scopeAcsActive: 0 }));
    expect(line).toContain('Next: pin down what "done" means as scope ACs (create_ac kind:scope).');
  });

  it("specify: everything settled → move to build", () => {
    tagAc(AC(2));
    const line = composeNextMove(baseFacts({ implAcsActive: 2, scopeAcsActive: 3 }));
    expect(line).toContain("Next: move to build (update_doc status:build).");
  });

  it("build: no tasks yet → break the narrative into tasks", () => {
    tagAc(AC(2));
    const line = composeNextMove(baseFacts({ phase: "build", taskCount: 0 }));
    expect(line).toContain("Next: break the narrative into tasks (create_task).");
  });

  it("build: an incomplete task outranks an untested AC", () => {
    tagAc(AC(2));
    const line = composeNextMove(
      baseFacts({
        phase: "build",
        taskCount: 3,
        incompleteTasks: ["t-1", "t-3"],
        untestedAcs: ["ac-2"],
      }),
    );
    expect(line).toContain(
      "spec-249 · build · 2 incomplete tasks (t-1, t-3), 1 untested AC (ac-2). Next: complete t-1.",
    );
  });

  it("build: tasks done, an AC still untested → write the tagged test", () => {
    tagAc(AC(2));
    const line = composeNextMove(
      baseFacts({ phase: "build", taskCount: 2, untestedAcs: ["ac-2"] }),
    );
    expect(line).toContain("Next: write the tagged test for ac-2.");
  });

  it("build: tasks done and ACs tested → move to verify", () => {
    tagAc(AC(2));
    const line = composeNextMove(baseFacts({ phase: "build", taskCount: 2 }));
    expect(line).toContain("Next: move to verify (update_doc status:verify).");
  });

  it("verify: an unverified AC → verify it against the running system", () => {
    tagAc(AC(2));
    const line = composeNextMove(
      baseFacts({ phase: "verify", taskCount: 2, untestedAcs: ["ac-4"] }),
    );
    expect(line).toContain("spec-249 · verify · 1 unverified AC (ac-4)");
    expect(line).toContain("Next: verify ac-4 against the running system.");
  });

  it("verify: all green → run the gate and hand to a human", () => {
    tagAc(AC(2));
    const line = composeNextMove(baseFacts({ phase: "verify", taskCount: 2 }));
    expect(line).toContain("all ACs verified");
    expect(line).toContain(
      "Next: run assess_spec target:done, then hand it to a human to sign off.",
    );
  });

  it("the line changes as state advances — it is not fixed text", () => {
    tagAc(AC(2));
    const open = composeNextMove(baseFacts({ openDecisions: ["dec-1"] }));
    const resolved = composeNextMove(
      baseFacts({ resolvedDecisionsWithoutImplAc: ["dec-1"] }),
    );
    const covered = composeNextMove(baseFacts({ implAcsActive: 1, scopeAcsActive: 2 }));
    expect(new Set([open, resolved, covered]).size).toBe(3);
  });
});

describe("composeNextMove — the verbose pointer is live, not a standing nag (ac-3)", () => {
  it("points to verbose when an open decision hides text", () => {
    tagAc(AC(3));
    expect(composeNextMove(baseFacts({ openDecisions: ["dec-1"] }))).toContain(
      "(get_doc verbose for the full decision/task text.)",
    );
  });

  it("points to verbose when there is an incomplete task", () => {
    tagAc(AC(3));
    expect(
      composeNextMove(baseFacts({ phase: "build", taskCount: 1, incompleteTasks: ["t-1"] })),
    ).toContain("get_doc verbose");
  });

  it("points to verbose when an AC is untested", () => {
    tagAc(AC(3));
    expect(
      composeNextMove(baseFacts({ phase: "build", taskCount: 1, untestedAcs: ["ac-1"] })),
    ).toContain("get_doc verbose");
  });

  it("omits the pointer for a trivial spec — no standing advertisement", () => {
    tagAc(AC(3));
    const line = composeNextMove(baseFacts({ implAcsActive: 2, scopeAcsActive: 3 }));
    expect(line).not.toContain("verbose");
    expect(line.endsWith(".")).toBe(true);
  });

  it("omits the pointer on a done spec with nothing outstanding", () => {
    tagAc(AC(3));
    const line = composeNextMove(baseFacts({ phase: "done", taskCount: 2 }));
    expect(line).not.toContain("verbose");
    expect(line).toBe(
      "spec-249 · done · closed. Next: reopen with update_doc only if something genuinely needs to change.",
    );
  });
});
