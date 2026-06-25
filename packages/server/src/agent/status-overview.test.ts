// spec-249 — the live spec-status overview, exercised as a PURE projection.
//
// composeStatusOverview is pure (no DB, no clock): a deterministic function of
// spec state. These unit tests pin the projection directly — the full census
// every call, failing surfaced distinctly from untested, and the phase-aware
// next action — which is what makes the overview LIVE rather than boilerplate.
//
// ac-1: the overview carries the FULL census (decisions total/unresolved, tasks
//       total/incomplete, ACs total/untested/failing) — never a phase subset.
// ac-3: it is live — derived from state, changes as state changes; no fixed text.
// ac-4: failing ACs are surfaced distinctly from untested ones.
// ac-5: the next action is phase-aware and concrete; done offers no action.

import { describe, it, expect } from "vitest";
import { tagAc } from "@memex-ai-ac/vitest";
import { composeStatusOverview, type StatusFacts } from "./tool-specs.js";

const AC = (n: number) =>
  `mindset-prod/memex-building-itself/specs/spec-249/acs/ac-${n}`;

const facts = (over: Partial<StatusFacts> = {}): StatusFacts => ({
  handle: "spec-249",
  phase: "build",
  decisionsTotal: 0,
  decisionsUnresolved: 0,
  openDecisions: [],
  resolvedDecisionsWithoutImplAc: [],
  scopeAcsActive: 0,
  tasksTotal: 0,
  incompleteTasks: [],
  acsTotal: 0,
  untestedAcs: [],
  failingAcs: [],
  ...over,
});

describe("composeStatusOverview — the full census, every call (ac-1)", () => {
  it("renders all three dimensions with totals and breakdowns", () => {
    tagAc(AC(1));
    const line = composeStatusOverview(
      facts({
        phase: "build",
        decisionsTotal: 3,
        decisionsUnresolved: 1,
        tasksTotal: 5,
        incompleteTasks: ["t-1", "t-3"],
        acsTotal: 7,
        untestedAcs: ["ac-6", "ac-7"],
      }),
    );
    expect(line).toBe(
      "spec-249 · build · decisions: 3 (1 unresolved) · tasks: 5 (2 incomplete) · " +
        "ACs: 7 (2 untested, 0 failing) · Next: complete t-1.",
    );
  });

  it("shows every count even when zero — the census is never narrowed by phase", () => {
    tagAc(AC(1));
    const specify = composeStatusOverview(facts({ phase: "specify", scopeAcsActive: 0 }));
    // decisions, tasks AND ACs all present in a specify-phase overview (the old
    // cut showed only decisions+impl-ACs in specify).
    expect(specify).toContain("decisions: 0 (0 unresolved)");
    expect(specify).toContain("tasks: 0 (0 incomplete)");
    expect(specify).toContain("ACs: 0 (0 untested, 0 failing)");
  });
});

describe("composeStatusOverview — failing is distinct from untested (ac-4)", () => {
  it("counts failing and untested in separate buckets", () => {
    tagAc(AC(4));
    const line = composeStatusOverview(
      facts({ acsTotal: 4, untestedAcs: ["ac-3"], failingAcs: ["ac-2"] }),
    );
    expect(line).toContain("ACs: 4 (1 untested, 1 failing)");
  });

  it("a failing AC is the loudest signal — it drives the next action over all else", () => {
    tagAc(AC(4));
    tagAc(AC(5));
    const line = composeStatusOverview(
      facts({
        phase: "build",
        tasksTotal: 3,
        incompleteTasks: ["t-1"],
        acsTotal: 3,
        untestedAcs: ["ac-3"],
        failingAcs: ["ac-2"],
      }),
    );
    // t-1 is incomplete and ac-3 untested, but the red test outranks both.
    expect(line).toContain("Next: fix the failing test for ac-2.");
  });
});

describe("composeStatusOverview — the next action is phase-aware (ac-5)", () => {
  it("specify: open decision → resolve it then give it an implementation AC", () => {
    tagAc(AC(5));
    expect(
      composeStatusOverview(
        facts({ phase: "specify", decisionsTotal: 1, decisionsUnresolved: 1, openDecisions: ["dec-1"] }),
      ),
    ).toContain("Next: resolve dec-1, then give it an implementation AC.");
  });

  it("specify: a resolved decision with no implementation AC", () => {
    tagAc(AC(5));
    expect(
      composeStatusOverview(
        facts({ phase: "specify", decisionsTotal: 1, resolvedDecisionsWithoutImplAc: ["dec-1"] }),
      ),
    ).toContain("Next: give dec-1 an implementation AC (create_ac kind:implementation).");
  });

  it("specify: no scope ACs yet → pin down done", () => {
    tagAc(AC(5));
    expect(composeStatusOverview(facts({ phase: "specify", scopeAcsActive: 0 }))).toContain(
      'Next: pin down what "done" means as scope ACs (create_ac kind:scope).',
    );
  });

  it("specify: everything settled → move to build", () => {
    tagAc(AC(5));
    expect(
      composeStatusOverview(facts({ phase: "specify", scopeAcsActive: 3 })),
    ).toContain("Next: move to build (update_doc status:build).");
  });

  it("build: no tasks → break the narrative into tasks", () => {
    tagAc(AC(5));
    expect(composeStatusOverview(facts({ phase: "build", tasksTotal: 0 }))).toContain(
      "Next: break the narrative into tasks (create_task).",
    );
  });

  it("build: tasks done, an AC untested → write the tagged test", () => {
    tagAc(AC(5));
    expect(
      composeStatusOverview(facts({ phase: "build", tasksTotal: 2, acsTotal: 2, untestedAcs: ["ac-2"] })),
    ).toContain("Next: write the tagged test for ac-2.");
  });

  it("verify: all green → run the gate and hand to a human", () => {
    tagAc(AC(5));
    expect(composeStatusOverview(facts({ phase: "verify", tasksTotal: 2, acsTotal: 2 }))).toContain(
      "Next: run assess_spec target:done, then hand to a human to sign off.",
    );
  });

  it("done: offers no forward action", () => {
    tagAc(AC(5));
    const line = composeStatusOverview(facts({ phase: "done", tasksTotal: 2, acsTotal: 2 }));
    expect(line).toContain("· done ·");
    expect(line).toContain(
      "Next: none — spec is done (reopen with update_doc only if something must change).",
    );
  });
});

describe("composeStatusOverview — the line is live, not fixed text (ac-3)", () => {
  it("distinct states yield distinct lines", () => {
    tagAc(AC(3));
    const a = composeStatusOverview(facts({ phase: "specify", decisionsTotal: 1, decisionsUnresolved: 1, openDecisions: ["dec-1"] }));
    const b = composeStatusOverview(facts({ phase: "build", tasksTotal: 2, incompleteTasks: ["t-1"], acsTotal: 1, untestedAcs: ["ac-1"] }));
    const c = composeStatusOverview(facts({ phase: "verify", tasksTotal: 2, acsTotal: 2 }));
    expect(new Set([a, b, c]).size).toBe(3);
  });

  it("the census moves with the numbers — no static substring survives a state change", () => {
    tagAc(AC(3));
    const before = composeStatusOverview(facts({ phase: "build", tasksTotal: 3, incompleteTasks: ["t-1", "t-2"], acsTotal: 2, untestedAcs: ["ac-1"] }));
    const after = composeStatusOverview(facts({ phase: "build", tasksTotal: 3, incompleteTasks: [], acsTotal: 2 }));
    expect(before).toContain("tasks: 3 (2 incomplete)");
    expect(after).toContain("tasks: 3 (0 incomplete)");
    expect(before).not.toBe(after);
  });
});
