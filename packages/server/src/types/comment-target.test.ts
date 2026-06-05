import { describe, it, expect } from "vitest";
import { commentTargetToColumns, type CommentTarget } from "./comment-target.js";

describe("commentTargetToColumns", () => {
  it("maps section target to sectionId column only", () => {
    const t: CommentTarget = { kind: "section", sectionId: "s-1" };
    expect(commentTargetToColumns(t)).toEqual({ sectionId: "s-1" });
  });

  it("maps decision target to decisionId column only", () => {
    const t: CommentTarget = { kind: "decision", decisionId: "d-1" };
    expect(commentTargetToColumns(t)).toEqual({ decisionId: "d-1" });
  });

  it("maps task target to taskId column only", () => {
    const t: CommentTarget = { kind: "task", taskId: "t-1" };
    expect(commentTargetToColumns(t)).toEqual({ taskId: "t-1" });
  });

  it("never sets two columns at once (XOR contract)", () => {
    const t: CommentTarget = { kind: "section", sectionId: "s-1" };
    const cols = commentTargetToColumns(t);
    const populated = [cols.sectionId, cols.decisionId, cols.taskId].filter(Boolean);
    expect(populated).toHaveLength(1);
  });
});
