// spec-259 t-3 — DB-backed end-to-end for the specify→build open-comment
// surface. REQUIRES Postgres. The orchestrator runs the DB suite serially —
// DO NOT run this concurrently with the other DB integration tests.
//
// Covers:
//   ac-1  — assessPhaseTransition(target:'build') surfaces the grouped block.
//   ac-6  — the SOFT build nudge fires (count + oldest age) when comments exist.
//   ac-10 — the open-set basis is resolved_at IS NULL: a resolved comment drops
//           out of the grouping (no second model).
//   ac-11 — the build transition is NOT gated: updateDocStatus to 'build'
//           succeeds with open comments present.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../db/connection.js";
import { documents, decisions, tasks, docComments } from "../db/schema.js";
import { createDocDraft, updateDocStatus } from "./documents.js";
import { createDecision } from "./decisions.js";
import { createTask } from "./tasks.js";
import { addComment, addDecisionComment, addTaskComment, resolveComment } from "./comments.js";
import { assessPhaseTransition, formatPhaseAssessment, _clearRecentAssessments } from "./phase-assessment.js";
import { makeTestMemex } from "./test-helpers.js";
import { tagAc } from "@memex-ai-ac/vitest";

const AC = (n: number) =>
  `mindset-prod/memex-building-itself/specs/spec-259/acs/ac-${n}`;

const createdDocIds: string[] = [];
let memexId: string;

beforeAll(async () => {
  memexId = await makeTestMemex();
});

afterAll(async () => {
  for (const id of createdDocIds) {
    await db.delete(docComments).where(eq(docComments.memexId, memexId)).catch(() => {});
    await db.delete(tasks).where(eq(tasks.docId, id)).catch(() => {});
    await db.delete(decisions).where(eq(decisions.docId, id)).catch(() => {});
    await db.delete(documents).where(eq(documents.id, id)).catch(() => {});
  }
});

describe("spec-259: specify→build open comments end-to-end", () => {
  it("groups open comments by anchor kind, fires the soft nudge, and does NOT gate (ac-1, ac-6, ac-11)", async () => {
    tagAc(AC(1));
    tagAc(AC(6));
    tagAc(AC(11));
    _clearRecentAssessments();

    const spec = await createDocDraft(memexId, "Build with open comments", "Purpose", "spec");
    createdDocIds.push(spec.id);
    await updateDocStatus(memexId, spec.id, "specify");

    const dec = await createDecision(memexId, spec.id, "Pick storage");
    const task = await createTask(memexId, spec.id, "Wire gate", "Do it");

    await addDecisionComment(memexId, dec.id, "ada lovelace", "decision question", {
      type: "question",
      source: "agent",
    });
    await new Promise((r) => setTimeout(r, 5));
    await addComment(memexId, spec.sections[0].id, "grace hopper", "section note");
    await new Promise((r) => setTimeout(r, 5));
    await addTaskComment(memexId, task.id, "alan turing", "task note", { source: "agent" });

    const assessment = await assessPhaseTransition(memexId, spec.id, "build", "not_applicable");

    // ac-1: grouping populated.
    expect(assessment.openCommentsDetail).toBeDefined();
    expect(assessment.openCommentsDetail!.totalOpen).toBe(3);
    expect(assessment.openCommentsDetail!.byAnchorKind.decision.count).toBe(1);
    expect(assessment.openCommentsDetail!.byAnchorKind.section.count).toBe(2); // section + task

    const rendered = formatPhaseAssessment(assessment);
    expect(rendered).toContain("Decision-anchored: 1");
    expect(rendered).toContain("Section-anchored: 2");
    expect(rendered).toContain("Ada Lovelace");

    // ac-6: soft nudge fires, naming the count.
    const commentNudge = assessment.nudges.find((n) => n.includes("open comment"));
    expect(commentNudge).toBeDefined();
    expect(commentNudge).toMatch(/3 open comments/);
    // Freshly-seeded → "oldest just now"; the "Nd ago" format is proven with an
    // injected `now` in the pure phase-assessment.comments-build.spec-259.test.ts.
    expect(commentNudge).toMatch(/oldest (just now|.*ago)/);

    // ac-11: the nudge is advisory — the transition still succeeds with comments open.
    const moved = await updateDocStatus(memexId, spec.id, "build");
    expect(moved.status).toBe("build");
  });

  it("the open-set basis is resolved_at IS NULL — a resolved comment drops out of the grouping (ac-10)", async () => {
    tagAc(AC(10));
    _clearRecentAssessments();

    const spec = await createDocDraft(memexId, "Resolved drops out", "Purpose", "spec");
    createdDocIds.push(spec.id);
    await updateDocStatus(memexId, spec.id, "specify");

    const dec = await createDecision(memexId, spec.id, "Pick lib");
    const openC = await addDecisionComment(memexId, dec.id, "ada", "still open", {
      type: "question",
      source: "agent",
    });
    const toResolve = await addComment(memexId, spec.sections[0].id, "grace", "will resolve");

    // Before resolution: 2 open (1 decision-anchored, 1 section-anchored).
    let a = await assessPhaseTransition(memexId, spec.id, "build", "not_applicable");
    expect(a.openCommentsDetail!.totalOpen).toBe(2);
    expect(a.openCommentsDetail!.byAnchorKind.section.count).toBe(1);

    await resolveComment(memexId, toResolve.id, "resolved");

    // After resolution: the resolved comment is gone; only the open one remains.
    _clearRecentAssessments();
    a = await assessPhaseTransition(memexId, spec.id, "build", "not_applicable");
    expect(a.openCommentsDetail!.totalOpen).toBe(1);
    expect(a.openCommentsDetail!.byAnchorKind.section.count).toBe(0);
    expect(a.openCommentsDetail!.byAnchorKind.decision.count).toBe(1);
    expect(a.openCommentsDetail!.comments[0].commentId).toBe(openC.id);
  });
});
