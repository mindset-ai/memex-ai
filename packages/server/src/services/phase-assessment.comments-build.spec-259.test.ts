// spec-259 t-3 — pure render + nudge tests for the specify→build open-comment
// surface.
//
// No DB: builds a synthetic PhaseAssessment and runs it through the pure
// `formatPhaseAssessment`, asserting the enriched "Open comments" block
// (anchor-kind grouping + oldest age + per-comment WHO/WHEN) and the SOFT build
// nudge. The DB-backed assessPhaseTransition path (that the nudge actually fires
// and the transition still succeeds end-to-end) is exercised in
// phase-assessment.integration.test.ts.

import { describe, it, expect } from "vitest";
import { tagAc } from "@memex-ai-ac/vitest";
import { formatPhaseAssessment, type PhaseAssessment } from "./phase-assessment.js";
import type { CommentsStatus, OpenComment } from "./comment-assessment.js";
import { groupCommentsByAnchorKind } from "./comment-assessment.js";

const AC = (n: number) =>
  `mindset-prod/memex-building-itself/specs/spec-259/acs/ac-${n}`;

// A few days back from "now" so timeAgo renders a stable "Nd ago"-shaped string
// regardless of when the suite runs.
const daysAgo = (n: number): Date => new Date(Date.now() - n * 24 * 60 * 60 * 1000);

function mkComment(o: {
  targetKind: OpenComment["target"]["kind"];
  handle: string;
  title: string | null;
  author: string;
  type?: string;
  snippet: string;
  createdAt: Date;
}): OpenComment {
  return {
    commentId: `c-${o.createdAt.getTime()}`,
    type: o.type ?? "discussion",
    target: { kind: o.targetKind, handle: o.handle, title: o.title },
    author: o.author,
    contentSnippet: o.snippet,
    createdAt: o.createdAt,
  };
}

function mkCommentsStatus(comments: OpenComment[]): CommentsStatus {
  return {
    briefId: "brief-uuid",
    specHandle: "spec-259",
    specTitle: "Surface open comments",
    totalOpen: comments.length,
    byType: { note: comments.length, question: 0, drift: 0, plan_revision: 0, other: 0 },
    comments,
    byAnchorKind: groupCommentsByAnchorKind(comments),
  };
}

function mkBuildAssessment(over: Partial<PhaseAssessment> = {}): PhaseAssessment {
  return {
    briefId: "brief-uuid",
    specHandle: "spec-259",
    specTitle: "Surface open comments",
    currentPhase: "specify",
    targetPhase: "build",
    transition: "specify → build",
    rubricNote: null,
    rubricProse: "## How to use this\n- proceed-with-caveats — transition is fine but flag <list>.",
    facts: {
      openDecisionsCount: 0,
      openDecisions: [],
      incompleteTasksCount: 0,
      readyTasksCount: 0,
      blockedTasksCount: 0,
      incompleteTasks: [],
      unresolvedDriftCount: 0,
      unresolvedPlanRevisionCount: 0,
      openCommentsCount: 0,
      openCommentsByType: {},
      acVerification: {
        totalActive: 0,
        covered: 0,
        verified: 0,
        failing: 0,
        stale: 0,
        untested: 0,
        accepted: 0,
        failingHandles: [],
        staleHandles: [],
      },
      openIssuesCount: 0,
      sections: [],
      resolvedDecisionCoverage: [],
      resolvedDecisionAcCoverage: [],
    },
    readiness: { outstandingItems: [], isClean: true },
    nudges: [],
    ...over,
  };
}

describe("spec-259: specify→build open-comment render (ac-1)", () => {
  it("renders comments grouped by anchor kind, with per-group oldest age + per-comment WHO/WHEN", () => {
    tagAc(AC(1));

    const comments = [
      mkComment({
        targetKind: "decision",
        handle: "dec-2",
        title: "Storage engine",
        author: "ada lovelace",
        type: "question",
        snippet: "are we sure about postgres here?",
        createdAt: daysAgo(9),
      }),
      mkComment({
        targetKind: "section",
        handle: "approach",
        title: "Approach",
        author: "grace hopper",
        snippet: "this needs a rollback plan",
        createdAt: daysAgo(4),
      }),
      mkComment({
        targetKind: "task",
        handle: "t-1",
        title: "Wire the gate",
        author: "alan turing",
        snippet: "blocked on the migration",
        createdAt: daysAgo(2),
      }),
    ];

    const a = mkBuildAssessment({
      facts: {
        ...mkBuildAssessment().facts,
        openCommentsCount: 3,
        openCommentsByType: { discussion: 2, question: 1 },
      },
      openCommentsDetail: mkCommentsStatus(comments),
    });

    const out = formatPhaseAssessment(a);

    // Grouping headers.
    expect(out).toContain("Decision-anchored: 1");
    expect(out).toContain("Section-anchored: 2"); // section + task collapse

    // Oldest age per group is surfaced via timeAgo (relative, "ago"-shaped).
    expect(out).toMatch(/Decision-anchored: 1 \(oldest .*ago\)/);
    expect(out).toMatch(/Section-anchored: 2 \(oldest .*ago\)/);

    // Per-comment WHO (title-cased) / WHEN (relative) / anchor / snippet.
    expect(out).toContain("Ada Lovelace");
    expect(out).toContain("Grace Hopper");
    expect(out).toContain("Alan Turing");
    expect(out).toMatch(/Ada Lovelace .*ago on decision dec-2 "Storage engine" \[question\]/);
    expect(out).toContain("are we sure about postgres here?");
    expect(out).toContain('on section approach "Approach"');
    expect(out).toContain('on task t-1 "Wire the gate"');
  });

  it("renders counts-only (no grouping block) when openCommentsDetail is absent (non-build targets)", () => {
    tagAc(AC(1));
    const a = mkBuildAssessment({
      targetPhase: "verify",
      transition: "build → verify",
      currentPhase: "build",
      facts: {
        ...mkBuildAssessment().facts,
        openCommentsCount: 2,
        openCommentsByType: { discussion: 2 },
      },
      // openCommentsDetail intentionally undefined.
    });
    const out = formatPhaseAssessment(a);
    expect(out).toContain("Open comments: 2");
    expect(out).not.toContain("Decision-anchored");
    expect(out).not.toContain("Section-anchored");
  });
});

describe("spec-259: specify→build open-comment SOFT nudge (ac-6, ac-11)", () => {
  it("renders the soft nudge naming count + oldest age, alongside a proceed-with-caveats rubric", () => {
    tagAc(AC(6));
    // The nudge string itself is produced by assessPhaseTransition; here we
    // assert formatPhaseAssessment surfaces it under ## Nudges and that the
    // build rubric offers the proceed-with-caveats verdict it feeds.
    const nudge =
      "There are 3 open comments on this Spec (oldest 9d ago). Walk the user through them before build — " +
      "answer the questions, fold accepted notes into the narrative, and resolve them — or proceed if they're not blockers.";
    const a = mkBuildAssessment({ nudges: [nudge] });
    const out = formatPhaseAssessment(a);

    expect(out).toContain("## Nudges");
    expect(out).toContain("3 open comments on this Spec");
    expect(out).toContain("oldest 9d ago");
    // The verdict the nudge drives toward is available in the rubric.
    expect(out).toContain("proceed-with-caveats");
  });

  it("the soft nudge is purely advisory — it does not add a transition-blocking outstanding item (ac-11)", () => {
    tagAc(AC(11));
    // A build assessment carrying the comment nudge keeps an EMPTY readiness
    // (isClean) — the nudge never manufactures a hold. (The end-to-end proof
    // that updateDocStatus still succeeds with open comments lives in the DB
    // integration test; updateDocStatus gates on nothing here.)
    const nudge = "There is 1 open comment on this Spec (oldest 2d ago). Walk the user through them before build — answer the questions, fold accepted notes into the narrative, and resolve them — or proceed if they're not blockers.";
    const a = mkBuildAssessment({ nudges: [nudge] });

    expect(a.readiness.isClean).toBe(true);
    expect(a.readiness.outstandingItems).toEqual([]);

    const out = formatPhaseAssessment(a);
    // No "Outstanding work" section is forced by the comment nudge.
    expect(out).not.toContain("## Outstanding work");
  });
});
