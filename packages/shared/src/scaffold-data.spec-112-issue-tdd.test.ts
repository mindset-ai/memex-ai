// spec-112 t-9 — the build-phase TDD red→green prompt for issue-derived Tasks.
//
// **ac-8** — the build-phase agent prompt (a markdown phase artefact per
// std-15, NOT inline code) prescribes a red→green TDD flow for issue-derived
// Tasks: write a failing unit/integration test that reproduces the Issue first
// and tag it to the AC handle (confirm a RED `test_event`), then implement the
// fix (confirm a GREEN `test_event`), with the red→green transition observable
// in the append-only `test_events` log for that AC.
//
// The artefact lives in `scaffold-data.ts` as a `shared_nudge` PromptBlock
// (`phase-build-issue-tdd`) whose `.text` IS markdown, plus a base
// GuidanceBlock targeting `{ phase:'build' }`. Per b-68 dec-6 + the drift guard
// (ac-20a) prompt prose is owned by `scaffold-data.ts` and a NEW `phases/*.md`
// file would be rejected — so the canonical markdown phase artefact for the
// build phase is this PromptBlockNode, projected onto the build phase via the
// `toNudge` loader. These assertions pin the prose intent + the build-phase
// wiring so a future re-word can't silently drop the failing-test-first
// directive.

import { describe, it, expect } from "vitest";
import { tagAc } from "@memex-ai-ac/vitest";
import { BASE_SCAFFOLD } from "./scaffold-data.js";
import { toNudge } from "./scaffold-model.js";

const AC8 = "mindset-prod/memex-building-itself/specs/spec-112/acs/ac-8";

const ISSUE_TDD_BLOCK = BASE_SCAFFOLD.promptBlocks.find(
  (b) => b.id === "phase-build-issue-tdd",
);

// The build-phase nudge the loader actually assembles for any tool call in
// build. `convert_issue_to_task` is the canonical issue-derived-Task tool, so
// we project through it; the block is phase-targeted (not tool-targeted) so it
// surfaces for any tool in build.
const BUILD_NUDGE = toNudge({
  dataset: BASE_SCAFFOLD,
  tool: "convert_issue_to_task",
  phase: "build",
});

describe("spec-112 t-9: build-phase issue-TDD prompt artefact (ac-8)", () => {
  it("a `phase-build-issue-tdd` markdown phase artefact exists as a shared_nudge prompt block", () => {
    tagAc(AC8);
    // The artefact IS a markdown phase block (std-15) — owned by the scaffold
    // model, not a `.md` file (drift guard ac-20a) and not inline code.
    expect(
      ISSUE_TDD_BLOCK,
      "BASE_SCAFFOLD must carry id `phase-build-issue-tdd`",
    ).toBeDefined();
    // shared_nudge so it rides the build-phase nudge footer to both surfaces.
    expect(ISSUE_TDD_BLOCK!.surface).toBe("shared_nudge");
    expect(ISSUE_TDD_BLOCK!.rationale.trim().length).toBeGreaterThan(0);
    // The text is markdown prose (a `## ` heading) — the phase artefact shape.
    expect(ISSUE_TDD_BLOCK!.text).toMatch(/(^|\n)##\s/);
  });

  it("is wired into the BUILD phase via the loader (toNudge projects it)", () => {
    tagAc(AC8);
    // The block must actually reach the agent on a build-phase call — a block
    // authored but not targeted to build would be silent. Assert the loader
    // surfaces its heading in the assembled build nudge.
    expect(BUILD_NUDGE).toContain(
      "Issue-derived tasks — failing test first (red→green)",
    );
    // And it must NOT bleed into other phases (it's build-only discipline).
    const planNudge = toNudge({
      dataset: BASE_SCAFFOLD,
      tool: "convert_issue_to_task",
      phase: "plan",
    });
    expect(planNudge).not.toContain("failing test first");
  });

  it("targets ISSUE-DERIVED tasks (the convert_issue_to_task lineage)", () => {
    tagAc(AC8);
    const text = ISSUE_TDD_BLOCK!.text;
    expect(text).toContain("convert_issue_to_task");
    expect(text.toLowerCase()).toContain("issue-derived");
  });

  it("prescribes the failing test FIRST — reproduce the Issue before the fix", () => {
    tagAc(AC8);
    const lower = ISSUE_TDD_BLOCK!.text.toLowerCase();
    // Failing-test-first directive.
    expect(lower).toContain("failing test first");
    // The test must REPRODUCE the Issue.
    expect(lower).toContain("reproduc");
    // Ordering discipline: test before the fix.
    expect(lower).toMatch(/before you[\s\S]*fix|reproduce the bug before/);
  });

  it("requires tagging the test to the AC handle", () => {
    tagAc(AC8);
    const text = ISSUE_TDD_BLOCK!.text;
    expect(text).toContain("tagAc");
    // The verifying AC the conversion minted (handle / ac-N), full ref.
    expect(text.toLowerCase()).toContain("ac");
    expect(text).toMatch(/ac-N|canonical ref/);
  });

  it("prescribes the red→green transition observable in the append-only test_events log", () => {
    tagAc(AC8);
    const text = ISSUE_TDD_BLOCK!.text;
    const lower = text.toLowerCase();
    // red → green transition language.
    expect(lower).toContain("red");
    expect(lower).toContain("green");
    expect(lower).toContain("red→green");
    // Evidence lives in the append-only test_events log for the AC.
    expect(text).toContain("test_event");
    expect(lower).toContain("append-only");
    // Red BEFORE green is the observable transition — a green with no prior
    // red is unverified.
    expect(lower).toMatch(/failing[\s\S]*test_event|red[\s\S]*test_event/);
    expect(lower).toMatch(/passing[\s\S]*test_event|green[\s\S]*test_event/);
  });

  it("ties the flow to the convert_issue_to_task contract (bug AC starts red, resolves on green)", () => {
    tagAc(AC8);
    const lower = ISSUE_TDD_BLOCK!.text.toLowerCase();
    // The conversion mints a verifying AC parented to the Issue; bug-AC red.
    expect(lower).toContain("verifying");
    expect(lower).toMatch(/starts\s+\*\*red\*\*|starts red/);
    // Green is the gate for marking the Task complete.
    expect(lower).toContain("complete");
  });
});
