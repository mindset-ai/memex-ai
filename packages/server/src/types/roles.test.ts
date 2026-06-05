import { describe, it, expect } from "vitest";
import {
  isRole,
  isMembershipStatus,
  isDocStatus,
  isTaskStatus,
  isDecisionStatus,
  isCommentType,
  isCommentSource,
  isDocType,
  ROLES,
  DOC_STATUSES,
  TASK_STATUSES,
  DECISION_STATUSES,
  COMMENT_TYPES,
  COMMENT_SOURCES,
  DOC_TYPES,
} from "./roles.js";

describe("type guards", () => {
  it("isRole accepts the canonical values and rejects others", () => {
    // Per t-11 of doc-15: the canonical role values are 'member' and
    // 'administrator'. The legacy 'user' literal was retired in the same task.
    expect(isRole("member")).toBe(true);
    expect(isRole("administrator")).toBe(true);
    expect(isRole("user")).toBe(false);
    expect(isRole("admin")).toBe(false);
    expect(isRole("")).toBe(false);
    expect(isRole(null)).toBe(false);
    expect(isRole(undefined)).toBe(false);
    expect(isRole(0)).toBe(false);
  });

  it("isMembershipStatus accepts active/disabled only", () => {
    expect(isMembershipStatus("active")).toBe(true);
    expect(isMembershipStatus("disabled")).toBe(true);
    expect(isMembershipStatus("suspended")).toBe(false);
  });

  it("isDocStatus matches the legacy + Spec-rename values (doc-10 dec-3/dec-4)", () => {
    for (const s of [
      "draft",
      "review",
      "implementation",
      "done",
      "approved",
      "plan",
      "build",
      "verify",
    ]) {
      expect(isDocStatus(s)).toBe(true);
    }
    expect(isDocStatus("DRAFT")).toBe(false);
    expect(isDocStatus("archived")).toBe(false);
  });

  it("isTaskStatus matches the three canonical values", () => {
    for (const s of ["not_started", "in_progress", "complete"]) {
      expect(isTaskStatus(s)).toBe(true);
    }
    expect(isTaskStatus("done")).toBe(false);
  });

  it("isDecisionStatus matches open/resolved/candidate/rejected", () => {
    for (const s of ["open", "resolved", "candidate", "rejected"]) {
      expect(isDecisionStatus(s)).toBe(true);
    }
    expect(isDecisionStatus("pending")).toBe(false);
  });

  it("isCommentType matches the 12 canonical values from Section 7", () => {
    for (const t of COMMENT_TYPES) {
      expect(isCommentType(t)).toBe(true);
    }
    expect(isCommentType("comment")).toBe(false);
    expect(isCommentType("")).toBe(false);
    expect(isCommentType(null)).toBe(false);
  });

  it("isCommentSource accepts only human/agent", () => {
    expect(isCommentSource("human")).toBe(true);
    expect(isCommentSource("agent")).toBe(true);
    expect(isCommentSource("system")).toBe(false);
  });

  it("isDocType matches the canonical doc types", () => {
    for (const t of DOC_TYPES) {
      expect(isDocType(t)).toBe(true);
    }
    expect(isDocType("note")).toBe(false);
  });
});

describe("readonly arrays mirror the union", () => {
  it("ROLES contains both roles", () => {
    // t-11 of doc-15 renamed the legacy 'user' role to 'member'.
    expect([...ROLES].sort()).toEqual(["administrator", "member"]);
  });
  it("DOC_STATUSES has the union of legacy and Spec-rename values (doc-10)", () => {
    // Legacy: draft, review, implementation, done, approved
    // Spec rename (dec-3, dec-4): plan, build, verify
    expect([...DOC_STATUSES].sort()).toEqual([
      "approved",
      "build",
      "done",
      "draft",
      "implementation",
      "plan",
      "review",
      "verify",
    ]);
  });
  it("TASK_STATUSES has all three", () => {
    expect(TASK_STATUSES).toHaveLength(3);
  });
  it("DECISION_STATUSES includes candidate and rejected", () => {
    expect([...DECISION_STATUSES].sort()).toEqual([
      "candidate",
      "open",
      "rejected",
      "resolved",
    ]);
  });
  it("COMMENT_TYPES has all 12 from Section 7", () => {
    expect(COMMENT_TYPES).toHaveLength(12);
  });
  it("COMMENT_SOURCES has human and agent", () => {
    expect([...COMMENT_SOURCES].sort()).toEqual(["agent", "human"]);
  });
  it("DOC_TYPES contains the v2 set", () => {
    // Post-merge: 'strategy' was renamed to 'mission' (migration 0028), then
    // 'brief' (doc-26 migration 0049), and finally migrated to 'spec' (b-105
    // migration 0063). All legacy values were migrated and dropped from the
    // union; new code uses 'spec' exclusively. The DB doesn't enforce a CHECK
    // on doc_type so this list is the canonical app-side allowlist; keep
    // this assertion in lockstep with DOC_TYPES.
    expect([...DOC_TYPES].sort()).toEqual([
      "adr",
      "document",
      "execution_plan",
      "runbook",
      "spec",
      "standard",
    ]);
  });
});
