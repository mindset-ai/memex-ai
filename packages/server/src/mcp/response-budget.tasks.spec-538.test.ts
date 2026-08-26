// spec-538 t-11 (ac-29, ac-30, ac-31, ac-32) — the tasks block, and the rule
// that decides what every item keeps.
//
// THE GUARD COMES FIRST, and this file is why the discipline matters. ac-4's
// fixture renders `formatFullDocState(doc, [], [])` — no tasks, ever. So the
// assertion "a representative large Spec stays under budget" validated a
// mechanism it could not observe, and the defect shipped past 44 tests and a
// green CI.
//
// std-45 already forbids exactly this: "A vacuity guard must be unfakeable.
// Assert the precondition the test depends on — that the collection is
// non-empty — before asserting the thing being claimed." Every test here
// asserts its fixture is real before asserting what the fixture proves.
//
// Measured on prod, 2026-08-26 — spec-538 cannot load itself:
//   sections 26,449 · decisions 14,347 (bounded) · TASKS 33,689 (unbounded)
//   · envelope 14,998  =  89,483, refused by the client and spilled.
// Of the task block, 9 complete tasks carry 30,606 — 91% of it.

import { describe, it, expect } from "vitest";
import { tagAc } from "@memex-ai-ac/vitest";
import { formatFullDocState } from "./formatters.js";
import { RESPONSE_BODY_BUDGET_CHARS } from "./response-budget.js";
import type { Doc, DocSection, Decision } from "../db/schema.js";
import type { TaskWithBlockers } from "../services/tasks.js";

const AC = (n: number) =>
  `mindset-prod/memex-building-itself/specs/spec-538/acs/ac-${n}`;

const baseDate = new Date("2026-03-25T12:00:00Z");

/** A task the size of a real one on this Spec: ~2,500 chars rendered. */
function makeTask(
  seq: number,
  opts: { complete: boolean; criteria?: number; checked?: number },
): TaskWithBlockers {
  const total = opts.criteria ?? 6;
  const checked = opts.checked ?? (opts.complete ? total : 0);
  return {
    id: `task-${seq}`,
    docId: "d1",
    seq,
    title: `Task ${seq} — a title of realistic length for a build-phase Spec`,
    description: "D".repeat(2_000),
    status: opts.complete ? "complete" : "not_started",
    blocked: false,
    blockedByDecisions: [],
    blockedByTasks: [],
    sectionRef: null,
    acceptanceCriteria: Array.from({ length: total }, (_, i) => ({
      description: `Criterion ${i + 1}: ${"c".repeat(110)}`,
      done: i < checked,
    })),
    createdAt: baseDate,
    updatedAt: baseDate,
    completedAt: opts.complete ? baseDate : null,
  } as unknown as TaskWithBlockers;
}

function makeDecision(seq: number, status: "open" | "resolved"): Decision {
  return {
    id: `dec-${seq}`,
    docId: "d1",
    seq,
    title: `Decision ${seq}`,
    status,
    resolution: status === "resolved" ? "R".repeat(2_000) : null,
    context: "X".repeat(1_500),
    createdAt: baseDate,
    updatedAt: baseDate,
    resolvedAt: status === "resolved" ? baseDate : null,
  } as unknown as Decision;
}

function makeSpec(proseChars: number): Doc & { sections: DocSection[] } {
  return {
    id: "d1",
    memexId: "m1",
    handle: "spec-1",
    title: "Task-heavy Spec",
    docType: "spec",
    status: "build",
    createdAt: baseDate,
    statusChangedAt: baseDate,
    version: 1,
    sensitive: false,
    sensitiveByName: null,
    checkedOutBy: null,
    checkedOutAt: null,
    sections: [
      {
        id: "s1",
        docId: "d1",
        sectionType: "overview",
        title: "Overview",
        content: "P".repeat(proseChars),
        seq: 1,
        position: 1,
        status: "active",
        createdAt: baseDate,
        updatedAt: baseDate,
      } as unknown as DocSection,
    ],
  } as unknown as Doc & { sections: DocSection[] };
}

function render(
  proseChars: number,
  decisions: Decision[],
  tasks: TaskWithBlockers[],
): string {
  // formatFullDocState's `tasks` param is TaskWithBlockers[]; the fixture builds
  // exactly that, so cast through unknown rather than to Task[] (which would
  // strip the blocker fields the READY/BLOCKED label is derived from).
  return formatFullDocState(
    makeSpec(proseChars),
    decisions,
    tasks as unknown as Parameters<typeof formatFullDocState>[2],
  );
}

/** spec-538's own shape, measured on prod: 26,449 prose · 7 decisions · 10 tasks (9 done). */
const SPEC_538_PROSE = 26_449;
const SPEC_538_DECISIONS = Array.from({ length: 7 }, (_, i) =>
  makeDecision(i + 1, "resolved"),
);
const SPEC_538_TASKS = [
  ...Array.from({ length: 9 }, (_, i) => makeTask(i + 1, { complete: true })),
  makeTask(10, { complete: false }),
];

describe("the tasks block is a measured region of the budget (ac-29)", () => {
  it("the fixture is real — it carries tasks, which is what the old guard did not", () => {
    tagAc(AC(29));
    // std-45: assert the precondition before asserting the claim. ac-4's fixture
    // passed [] here, so its budget assertion was vacuous for this whole region.
    expect(SPEC_538_TASKS.length).toBe(10);
    expect(SPEC_538_TASKS.filter((t) => t.status === "complete")).toHaveLength(9);
    const unbounded = render(SPEC_538_PROSE, SPEC_538_DECISIONS, SPEC_538_TASKS);
    expect(unbounded.length).toBeGreaterThan(20_000); // there is real weight here
  });

  it("spec-538's own shape renders under the budget — the Spec that defines the bound loads itself", () => {
    tagAc(AC(29));
    const out = render(SPEC_538_PROSE, SPEC_538_DECISIONS, SPEC_538_TASKS);
    expect(out.length).toBeLessThanOrEqual(RESPONSE_BODY_BUDGET_CHARS);
  });
});

describe("status decides what an item keeps (ac-30)", () => {
  it("a complete task is mapped; an incomplete one keeps its description and checklist", () => {
    tagAc(AC(30));
    // Force tier 2 — with two tasks and short prose the doc fits, nothing is
    // budgeted, and complete/incomplete correctly render alike. The claim is
    // about what a BUDGET does, so the fixture has to reach one.
    const out = render(SPEC_538_PROSE, SPEC_538_DECISIONS, [
      makeTask(1, { complete: true }),
      makeTask(2, { complete: false }),
    ]);
    expect(out).toContain("Response shape: EXCERPTED");
    // Both are named and reachable…
    expect(out).toContain("Task 1");
    expect(out).toContain("Task 2");
    expect(out).toContain("ref: t-1");
    expect(out).toContain("ref: t-2");
    // …but only the incomplete one carries its working detail.
    const t1 = out.slice(out.indexOf("t-1"), out.indexOf("t-2"));
    const t2 = out.slice(out.indexOf("t-2"));
    expect(t2.length).toBeGreaterThan(t1.length * 2);
  });

  it("more outstanding work means more kept — two Specs identical but for completion state", () => {
    tagAc(AC(30));
    const allDone = Array.from({ length: 10 }, (_, i) =>
      makeTask(i + 1, { complete: true }),
    );
    const noneDone = Array.from({ length: 10 }, (_, i) =>
      makeTask(i + 1, { complete: false }),
    );
    const a = render(SPEC_538_PROSE, SPEC_538_DECISIONS, allDone);
    const b = render(SPEC_538_PROSE, SPEC_538_DECISIONS, noneDone);

    expect(b.length).toBeGreaterThan(a.length);
    // …and both still fit.
    expect(a.length).toBeLessThanOrEqual(RESPONSE_BODY_BUDGET_CHARS);
    expect(b.length).toBeLessThanOrEqual(RESPONSE_BODY_BUDGET_CHARS);
  });

  it("an OPEN decision is kept where a resolved one is excerpted — the live defect in shipped code", () => {
    tagAc(AC(30));
    const decisions = [makeDecision(1, "open"), makeDecision(2, "resolved")];
    expect(decisions.filter((d) => d.status === "open")).toHaveLength(1);

    const out = render(SPEC_538_PROSE, decisions, SPEC_538_TASKS);
    // Slice each decision to the NEXT boundary — an earlier version ran the
    // 'resolved' slice to the end of the document, so it measured the whole
    // tasks block and reported the open decision as the smaller of the two.
    const open = out.slice(out.indexOf("Decision 1"), out.indexOf("Decision 2"));
    const resolved = out.slice(out.indexOf("Decision 2"), out.indexOf("## Tasks"));
    // The open decision — the one the reader must act on — keeps its context.
    expect(open).toContain("X".repeat(500));
    expect(open.length).toBeGreaterThan(resolved.length);
  });
});

describe("the bound holds by construction, not by typical sizes (ac-31)", () => {
  it("fifty incomplete tasks with long checklists still fit — checked criteria collapse to a count", () => {
    tagAc(AC(31));
    // "Keep the checklist whole" is a PER-ITEM guarantee, and a per-item
    // guarantee is not a bound — verbatim dec-1's objection to per-decision
    // constants. This is the case that proves the fallback exists.
    const fifty = Array.from({ length: 50 }, (_, i) =>
      makeTask(i + 1, { complete: false, criteria: 12, checked: 6 }),
    );
    expect(fifty).toHaveLength(50);

    const out = render(SPEC_538_PROSE, SPEC_538_DECISIONS, fifty);
    expect(out.length).toBeLessThanOrEqual(RESPONSE_BODY_BUDGET_CHARS);
  });

  it("no task count blows the budget", () => {
    tagAc(AC(31));
    for (const n of [1, 10, 50, 200, 1_000]) {
      const tasks = Array.from({ length: n }, (_, i) =>
        makeTask(i + 1, { complete: false }),
      );
      const out = render(SPEC_538_PROSE, SPEC_538_DECISIONS, tasks);
      expect(out.length, `${n} tasks rendered ${out.length} chars`).toBeLessThanOrEqual(
        RESPONSE_BODY_BUDGET_CHARS,
      );
    }
  });
});

describe("every marker names what was actually removed (ac-32)", () => {
  it("the tier declaration covers tasks, not only decisions and sections", () => {
    tagAc(AC(32));
    const out = render(SPEC_538_PROSE, SPEC_538_DECISIONS, SPEC_538_TASKS);
    const shapeLine = out.match(/^Response shape: .*$/m)?.[0] ?? "";
    expect(shapeLine).not.toBe("");
    expect(shapeLine.toLowerCase()).toContain("task");
  });

  it("a decision whose context was DELETED does not say only 'shortened'", () => {
    tagAc(AC(32));
    const out = render(SPEC_538_PROSE, SPEC_538_DECISIONS, SPEC_538_TASKS);
    // Context is dropped entirely when a budget applies — deliberate (t-3), but
    // the marker must say so rather than speaking only of the resolution.
    expect(out).not.toContain("Context: ");
    const marker = out.match(/… \[[^\]]*\]/)?.[0] ?? "";
    expect(marker).not.toBe("");
    expect(marker.toLowerCase()).toMatch(/context|background|omitted|not shown/);
  });

  it("a decision shown with no excerpt at all does not claim to be 'shortened'", () => {
    tagAc(AC(32));
    // Tier 3: prose alone exceeds the budget, so the per-decision allowance is 0
    // and nothing of the resolution is rendered.
    const out = render(90_000, SPEC_538_DECISIONS, SPEC_538_TASKS);
    expect(out).toContain("Response shape:");
    expect(out).not.toContain("R".repeat(100)); // no resolution text survived
    const marker = out.match(/… \[[^\]]*\]/)?.[0] ?? "";
    expect(marker.toLowerCase()).not.toContain("shortened");
  });
});
