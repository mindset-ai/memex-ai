// spec-126 — the reviewer-mode prompt overlay (dec-4 / dec-5).
//
// buildSystemBlocks appends BASE_REVIEW only when role=reviewer, AFTER the
// phase blocks + phase guidance, so the assembled reviewer prompt is
// phase-composed for free. These are pure assertions on the assembled prompt
// text — no DB, no LLM.
import { describe, it, expect } from "vitest";
import { BASE_REVIEW, BASE_SCAFFOLD } from "@memex/shared";
import { tagAc } from "@memex-ai-ac/vitest";
import { buildSystemBlocks } from "./system-prompt.js";

const AC = (n: number) => `mindset-prod/memex-building-itself/specs/spec-126/acs/ac-${n}`;

const CTX = "## Document Context\nsome doc";
// A stable phrase from the single-sourced review block — assert against the
// scaffold node's own text so the test tracks the source, not a copy.
const REVIEW_MARKER = BASE_REVIEW.text.slice(0, 40);

function instructionText(reviewer: boolean, phase: "plan" | "verify" = "plan"): string {
  // (documentContext, phase, readOnly, reviewer)
  const blocks = buildSystemBlocks(CTX, phase, false, reviewer);
  return blocks[0]!.text;
}

describe("spec-126 reviewer prompt overlay", () => {
  it("appends the single-sourced REVIEW_BLOCK only for reviewers; editors never see it (ac-2, ac-8)", () => {
    tagAc(AC(2));
    tagAc(AC(8));

    const reviewerPrompt = instructionText(true);
    const editorPrompt = instructionText(false);

    // Reviewer prompt carries the review posture; editor prompt does not.
    expect(reviewerPrompt).toContain(REVIEW_MARKER);
    expect(editorPrompt).not.toContain(REVIEW_MARKER);

    // ac-8: the prose is a single Scaffold node (BASE_REVIEW), not inlined — the
    // appended text equals the scaffold node's text verbatim.
    expect(reviewerPrompt).toContain(BASE_REVIEW.text);

    // ac-8: no parallel modes/roles axis was added to the scaffold model — the
    // overlay is a single appended block, exactly like read-only.
    expect("modes" in BASE_SCAFFOLD).toBe(false);
    expect("roles" in BASE_SCAFFOLD).toBe(false);
  });

  it("the review block instructs standards-grounding and yes/no confirmation before mutations (ac-14)", () => {
    tagAc(AC(14));
    // (a) ground the review in Standards: search them + cite [per std-N].
    expect(BASE_REVIEW.text).toContain("search_memex");
    expect(BASE_REVIEW.text.toLowerCase()).toContain("standard");
    expect(BASE_REVIEW.text).toContain("[per std-N]");
    // (b) confirm comment/Issue wording via the render_confirmation yes/no tool.
    expect(BASE_REVIEW.text).toContain("render_confirmation");
  });

  it("the reviewer prompt is phase-composed — it differs between plan and verify (ac-9)", () => {
    tagAc(AC(9));

    const planReviewer = instructionText(true, "plan");
    const verifyReviewer = instructionText(true, "verify");

    // Both carry the review posture...
    expect(planReviewer).toContain(REVIEW_MARKER);
    expect(verifyReviewer).toContain(REVIEW_MARKER);
    // ...but the surrounding phase orientation differs, so the assembled
    // reviewer prompt is not phase-invariant.
    expect(planReviewer).not.toEqual(verifyReviewer);
  });
});
