// spec-259 t-3 — pure unit tests for the anchor-kind grouping of open comments.
//
// No DB: exercises `groupCommentsByAnchorKind` / `anchorKindForTarget` directly
// against synthetic OpenComment lists. The DB-backed end-to-end (open-set basis
// = resolved_at IS NULL) lives in comment-assessment.integration.test.ts.

import { describe, it, expect } from "vitest";
import { tagAc } from "@memex-ai-ac/vitest";
import {
  anchorKindForTarget,
  groupCommentsByAnchorKind,
  type OpenComment,
} from "./comment-assessment.js";

const AC = (n: number) =>
  `mindset-prod/memex-building-itself/specs/spec-259/acs/ac-${n}`;

function mkComment(
  overrides: Partial<OpenComment> & {
    targetKind: OpenComment["target"]["kind"];
    createdAt: Date;
  },
): OpenComment {
  const { targetKind, createdAt, ...rest } = overrides;
  return {
    commentId: rest.commentId ?? `c-${createdAt.getTime()}`,
    type: rest.type ?? "discussion",
    target: rest.target ?? {
      kind: targetKind,
      handle: targetKind === "decision" ? "dec-1" : "approach",
      title: "T",
    },
    author: rest.author ?? "jane doe",
    contentSnippet: rest.contentSnippet ?? "snippet",
    createdAt,
  };
}

describe("spec-259: open comments grouped by anchor kind (ac-1)", () => {
  it("decision targets are decision-anchored; section + task targets are section-anchored", () => {
    tagAc(AC(1));
    expect(anchorKindForTarget("decision")).toBe("decision");
    expect(anchorKindForTarget("section")).toBe("section");
    // Tasks collapse into the section-anchored (narrative) group.
    expect(anchorKindForTarget("task")).toBe("section");
  });

  it("groups oldest-first comments and reports the oldest createdAt per group", () => {
    tagAc(AC(1));
    // Oldest-first input (as assessCommentsStatus produces).
    const comments: OpenComment[] = [
      mkComment({ targetKind: "decision", createdAt: new Date("2026-06-01T00:00:00Z") }),
      mkComment({ targetKind: "section", createdAt: new Date("2026-06-05T00:00:00Z") }),
      mkComment({ targetKind: "task", createdAt: new Date("2026-06-08T00:00:00Z") }),
      mkComment({ targetKind: "decision", createdAt: new Date("2026-06-10T00:00:00Z") }),
    ];

    const grouped = groupCommentsByAnchorKind(comments);

    expect(grouped.decision.count).toBe(2);
    expect(grouped.section.count).toBe(2); // section + task

    // Oldest per group = the first (oldest-first order preserved).
    expect(grouped.decision.oldestCreatedAt).toEqual(new Date("2026-06-01T00:00:00Z"));
    expect(grouped.section.oldestCreatedAt).toEqual(new Date("2026-06-05T00:00:00Z"));

    // Member order is preserved within each group.
    expect(grouped.decision.comments.map((c) => c.createdAt.toISOString())).toEqual([
      "2026-06-01T00:00:00.000Z",
      "2026-06-10T00:00:00.000Z",
    ]);
    expect(grouped.section.comments.map((c) => c.target.kind)).toEqual([
      "section",
      "task",
    ]);
  });

  it("an empty group reports count 0 and null oldest age", () => {
    tagAc(AC(1));
    const grouped = groupCommentsByAnchorKind([
      mkComment({ targetKind: "decision", createdAt: new Date("2026-06-01T00:00:00Z") }),
    ]);
    expect(grouped.section.count).toBe(0);
    expect(grouped.section.oldestCreatedAt).toBeNull();
    expect(grouped.section.comments).toEqual([]);
  });

  it("operates on whatever it is given — it has no notion of resolved state (ac-10)", () => {
    // ac-10: the open-set basis (resolved_at IS NULL) is the SOLE filter, applied
    // by assessCommentsStatus's query. The grouper holds no second model — it
    // groups every comment handed to it, so there is no place for a divergent
    // 'open' definition to creep in.
    tagAc(AC(10));
    const all = [
      mkComment({ targetKind: "decision", createdAt: new Date("2026-06-01T00:00:00Z") }),
      mkComment({ targetKind: "section", createdAt: new Date("2026-06-02T00:00:00Z") }),
    ];
    const grouped = groupCommentsByAnchorKind(all);
    expect(grouped.decision.count + grouped.section.count).toBe(all.length);
  });
});
