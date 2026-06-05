import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../db/connection.js";
import { documents, decisions, tasks, docComments } from "../db/schema.js";
import { createDocDraft, updateDocStatus } from "./documents.js";
import { createDecision } from "./decisions.js";
import { createTask } from "./tasks.js";
import { addComment, addDecisionComment, addTaskComment, resolveComment } from "./comments.js";
import { assessCommentsStatus } from "./comment-assessment.js";
import { NotFoundError } from "../types/errors.js";
import { makeTestMemex } from "./test-helpers.js";

const createdDocIds: string[] = [];

afterAll(async () => {
  for (const id of createdDocIds) {
    await db.delete(docComments).where(eq(docComments.memexId, memexId)).catch(() => {});
    await db.delete(tasks).where(eq(tasks.docId, id)).catch(() => {});
    await db.delete(decisions).where(eq(decisions.docId, id)).catch(() => {});
    await db.delete(documents).where(eq(documents.id, id)).catch(() => {});
  }
});

let memexId: string;
beforeAll(async () => {
  memexId = await makeTestMemex();
});

describe("assessCommentsStatus", () => {
  it("returns NotFoundError for unknown briefId", async () => {
    await expect(
      assessCommentsStatus(memexId, "00000000-0000-0000-0000-000000000000"),
    ).rejects.toThrow(NotFoundError);
  });

  it("returns zero counts when no open comments", async () => {
    const spec = await createDocDraft(memexId, "No comments", "Purpose", "spec");
    createdDocIds.push(spec.id);
    const result = await assessCommentsStatus(memexId, spec.id);
    expect(result.totalOpen).toBe(0);
    expect(result.byType).toEqual({ note: 0, question: 0, drift: 0, plan_revision: 0, other: 0 });
    expect(result.comments).toEqual([]);
  });

  it("aggregates mixed types across all three target kinds, oldest-first", async () => {
    const spec = await createDocDraft(memexId, "Mixed", "Purpose", "spec");
    createdDocIds.push(spec.id);
    await updateDocStatus(memexId, spec.id, "build");

    const dec = await createDecision(memexId, spec.id, "Choose lib");
    const task = await createTask(memexId, spec.id, "Implement", "Do it");

    // Insert in a deliberate chronological order; expect oldest-first sort.
    const c1 = await addComment(memexId, spec.sections[0].id, "alice", "section question", {
      type: "question",
    });
    await new Promise((r) => setTimeout(r, 5));
    const c2 = await addDecisionComment(memexId, dec.id, "bob", "decision drift", {
      type: "drift",
      source: "agent",
    });
    await new Promise((r) => setTimeout(r, 5));
    const c3 = await addTaskComment(memexId, task.id, "carol", "task plan revision", {
      type: "plan_revision",
      source: "agent",
    });

    const result = await assessCommentsStatus(memexId, spec.id);
    expect(result.totalOpen).toBe(3);
    expect(result.byType.question).toBe(1);
    expect(result.byType.drift).toBe(1);
    expect(result.byType.plan_revision).toBe(1);
    expect(result.byType.note).toBe(0);

    // Oldest first
    expect(result.comments[0].commentId).toBe(c1.id);
    expect(result.comments[1].commentId).toBe(c2.id);
    expect(result.comments[2].commentId).toBe(c3.id);

    // Target resolution
    expect(result.comments[0].target.kind).toBe("section");
    expect(result.comments[1].target.kind).toBe("decision");
    expect(result.comments[1].target.handle).toBe(`dec-${dec.seq}`);
    expect(result.comments[2].target.kind).toBe("task");
    expect(result.comments[2].target.handle).toBe(`t-${task.seq}`);
  });

  it("excludes resolved comments", async () => {
    const spec = await createDocDraft(memexId, "Resolved excluded", "Purpose", "spec");
    createdDocIds.push(spec.id);
    const c = await addComment(memexId, spec.sections[0].id, "alice", "stale", {
      type: "discussion",
    });
    await resolveComment(memexId, c.id, "addressed");

    const result = await assessCommentsStatus(memexId, spec.id);
    expect(result.totalOpen).toBe(0);
  });

  it("truncates long content to a snippet", async () => {
    const spec = await createDocDraft(memexId, "Snippet", "Purpose", "spec");
    createdDocIds.push(spec.id);
    const longContent = "x".repeat(500);
    await addComment(memexId, spec.sections[0].id, "alice", longContent, {
      type: "discussion",
    });

    const result = await assessCommentsStatus(memexId, spec.id);
    expect(result.comments[0].contentSnippet.length).toBeLessThanOrEqual(121); // 120 + ellipsis
    expect(result.comments[0].contentSnippet.endsWith("…")).toBe(true);
  });
});
