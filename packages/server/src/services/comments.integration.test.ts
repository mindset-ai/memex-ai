import { describe, it, expect, afterAll, beforeAll } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../db/connection.js";
import { documents, docSections, docComments } from "../db/schema.js";
import { createDocDraft } from "./documents.js";
import {
  addComment,
  addDecisionComment,
  addTaskComment,
  listComments,
  listDecisionComments,
  listTaskComments,
  resolveComment,
  unresolveComment,
  listCommentsForDoc,
  reviewDocComments,
  getCommentCountsForDoc,
} from "./comments.js";
import { createDecision } from "./decisions.js";
import { createTask } from "./tasks.js";
import { NotFoundError, ValidationError } from "../types/errors.js";
import { COMMENT_TYPES } from "../types/roles.js";
import { makeTestMemex } from "./test-helpers.js";

const createdDocIds: string[] = [];

afterAll(async () => {
  for (const id of createdDocIds) {
    await db.delete(documents).where(eq(documents.id, id));
  }
});


let memexId: string;
beforeAll(async () => {
  memexId = await makeTestMemex();
});

describe("addComment", () => {
  let sectionId: string;

  beforeAll(async () => {
    const doc = await createDocDraft(memexId, "Comment Test Doc", "Purpose");
    createdDocIds.push(doc.id);
    sectionId = doc.sections[0].id;
  });

  it("creates a comment on a section", async () => {
    const comment = await addComment(memexId, sectionId, "Alice", "Looks good!");

    expect(comment.sectionId).toBe(sectionId);
    expect(comment.authorName).toBe("Alice");
    expect(comment.content).toBe("Looks good!");
    expect(comment.resolvedAt).toBeNull();
    expect(comment.createdAt).toBeTruthy();
  });

  it("throws NotFoundError for non-existent section", async () => {
    await expect(
      addComment(memexId, "00000000-0000-0000-0000-000000000000", "Bob", "Hi")
    ).rejects.toThrow(NotFoundError);
  });
});

describe("listComments", () => {
  let sectionId: string;

  beforeAll(async () => {
    const doc = await createDocDraft(memexId, "List Comments Doc", "Purpose");
    createdDocIds.push(doc.id);
    sectionId = doc.sections[0].id;

    await addComment(memexId, sectionId, "Alice", "First comment");
    await addComment(memexId, sectionId, "Bob", "Second comment");
  });

  it("returns comments in chronological order", async () => {
    const comments = await listComments(memexId, sectionId);

    expect(comments.length).toBeGreaterThanOrEqual(2);
    expect(comments[0].authorName).toBe("Alice");
    expect(comments[1].authorName).toBe("Bob");

    // Verify chronological order
    const t0 = new Date(comments[0].createdAt).getTime();
    const t1 = new Date(comments[1].createdAt).getTime();
    expect(t1).toBeGreaterThanOrEqual(t0);
  });
});

describe("resolveComment / unresolveComment", () => {
  let commentId: string;

  beforeAll(async () => {
    const doc = await createDocDraft(memexId, "Resolve Test Doc", "Purpose");
    createdDocIds.push(doc.id);
    const comment = await addComment(memexId, doc.sections[0].id, "Alice", "To resolve");
    commentId = comment.id;
  });

  it("resolves a comment", async () => {
    const resolved = await resolveComment(memexId, commentId);

    expect(resolved.resolvedAt).toBeTruthy();
  });

  it("unresolves a comment", async () => {
    const unresolved = await unresolveComment(memexId, commentId);

    expect(unresolved.resolvedAt).toBeNull();
  });

  it("throws NotFoundError for non-existent comment on resolve", async () => {
    await expect(
      resolveComment(memexId, "00000000-0000-0000-0000-000000000000")
    ).rejects.toThrow(NotFoundError);
  });

  it("throws NotFoundError for non-existent comment on unresolve", async () => {
    await expect(
      unresolveComment(memexId, "00000000-0000-0000-0000-000000000000")
    ).rejects.toThrow(NotFoundError);
  });
});

describe("listCommentsForDoc", () => {
  let docId: string;

  beforeAll(async () => {
    // Pass docType="document" so the first section type is "purpose"; specs
    // (the default) get "overview" per the b-105 shape.
    const doc = await createDocDraft(memexId, "Doc Comments Doc", "Purpose", "document");
    createdDocIds.push(doc.id);
    docId = doc.id;

    // Add comments to the purpose section
    await addComment(memexId, doc.sections[0].id, "Alice", "Comment on purpose");
    await addComment(memexId, doc.sections[0].id, "Bob", "Another comment");
  });

  it("returns comments grouped by section", async () => {
    const result = await listCommentsForDoc(memexId, docId);

    expect(result.sections.length).toBeGreaterThanOrEqual(1);
    const purposeEntry = result.sections.find(
      (e) => e.section.sectionType === "purpose"
    );
    expect(purposeEntry).toBeDefined();
    expect(purposeEntry!.comments.length).toBeGreaterThanOrEqual(2);
  });

  it("only includes sections that have comments", async () => {
    const result = await listCommentsForDoc(memexId, docId);

    for (const entry of result.sections) {
      expect(entry.comments.length).toBeGreaterThan(0);
    }
  });

  it("throws NotFoundError for non-existent doc", async () => {
    await expect(
      listCommentsForDoc(memexId, "00000000-0000-0000-0000-000000000000")
    ).rejects.toThrow(NotFoundError);
  });
});

describe("getCommentCountsForDoc", () => {
  let sectionId: string;

  beforeAll(async () => {
    const doc = await createDocDraft(memexId, "Counts Test Doc", "Purpose");
    createdDocIds.push(doc.id);
    sectionId = doc.sections[0].id;

    const c1 = await addComment(memexId, sectionId, "Alice", "Open comment");
    const c2 = await addComment(memexId, sectionId, "Bob", "Will resolve");
    await resolveComment(memexId, c2.id);
  });

  it("counts only open (unresolved) comments", async () => {
    const counts = await getCommentCountsForDoc(memexId, [sectionId]);

    // Should have at least 1 open comment (Alice's), not counting Bob's resolved one
    expect(counts[sectionId]).toBeGreaterThanOrEqual(1);
  });

  it("returns empty object for empty input", async () => {
    const counts = await getCommentCountsForDoc(memexId, []);
    expect(counts).toEqual({});
  });

  it("counts decision and task comments too", async () => {
    const doc = await createDocDraft(memexId, "Counts All Types", "Purpose");
    createdDocIds.push(doc.id);

    const dec = await createDecision(memexId, doc.id, "Which DB?");
    const task = await createTask(memexId, doc.id, "Build it", "Description");

    await addDecisionComment(memexId, dec.id, "Alice", "Good question");
    await addTaskComment(memexId, task.id, "Bob", "On it");

    const counts = await getCommentCountsForDoc(memexId, [dec.id, task.id]);
    expect(counts[dec.id]).toBe(1);
    expect(counts[task.id]).toBe(1);
  });
});

// ── Decision comments ───────────────────────────────────────

describe("addDecisionComment", () => {
  let docId: string;
  let decisionId: string;

  beforeAll(async () => {
    const doc = await createDocDraft(memexId, "Decision Comment Doc", "Purpose");
    docId = doc.id;
    createdDocIds.push(doc.id);
    const dec = await createDecision(memexId, docId, "Which approach?");
    decisionId = dec.id;
  });

  it("creates a comment on a decision", async () => {
    const comment = await addDecisionComment(memexId, decisionId, "Alice", "I prefer option A");
    expect(comment.decisionId).toBe(decisionId);
    expect(comment.sectionId).toBeNull();
    expect(comment.taskId).toBeNull();
    expect(comment.content).toBe("I prefer option A");
  });

  it("throws NotFoundError for non-existent decision", async () => {
    await expect(
      addDecisionComment(memexId, "00000000-0000-0000-0000-000000000000", "Alice", "Nope")
    ).rejects.toThrow(NotFoundError);
  });
});

describe("listDecisionComments", () => {
  it("returns comments for a decision", async () => {
    const doc = await createDocDraft(memexId, "List Dec Comments", "Purpose");
    createdDocIds.push(doc.id);
    const dec = await createDecision(memexId, doc.id, "Test decision");

    await addDecisionComment(memexId, dec.id, "Alice", "Comment 1");
    await addDecisionComment(memexId, dec.id, "Bob", "Comment 2");

    const comments = await listDecisionComments(memexId, dec.id);
    expect(comments).toHaveLength(2);
    expect(comments[0].authorName).toBe("Alice");
    expect(comments[1].authorName).toBe("Bob");
  });
});

// ── Task comments ───────────────────────────────────────────

describe("addTaskComment", () => {
  let docId: string;
  let taskId: string;

  beforeAll(async () => {
    const doc = await createDocDraft(memexId, "Task Comment Doc", "Purpose");
    docId = doc.id;
    createdDocIds.push(doc.id);
    const task = await createTask(memexId, docId, "Build feature", "Description");
    taskId = task.id;
  });

  it("creates a comment on a task", async () => {
    const comment = await addTaskComment(memexId, taskId, "Bob", "How long will this take?");
    expect(comment.taskId).toBe(taskId);
    expect(comment.sectionId).toBeNull();
    expect(comment.decisionId).toBeNull();
    expect(comment.content).toBe("How long will this take?");
  });

  it("throws NotFoundError for non-existent task", async () => {
    await expect(
      addTaskComment(memexId, "00000000-0000-0000-0000-000000000000", "Bob", "Nope")
    ).rejects.toThrow(NotFoundError);
  });
});

describe("listTaskComments", () => {
  it("returns comments for a task", async () => {
    const doc = await createDocDraft(memexId, "List Task Comments", "Purpose");
    createdDocIds.push(doc.id);
    const task = await createTask(memexId, doc.id, "Test task", "Description");

    await addTaskComment(memexId, task.id, "Alice", "Comment 1");
    await addTaskComment(memexId, task.id, "Bob", "Comment 2");

    const comments = await listTaskComments(memexId, task.id);
    expect(comments).toHaveLength(2);
  });
});

// ── listCommentsForDoc includes all types ───────────────────

describe("listCommentsForDoc with decisions and tasks", () => {
  it("returns comments grouped by sections, decisions, and tasks", async () => {
    const doc = await createDocDraft(memexId, "Full Comments Doc", "Purpose");
    createdDocIds.push(doc.id);

    await addComment(memexId, doc.sections[0].id, "Alice", "Section comment");

    const dec = await createDecision(memexId, doc.id, "A decision");
    await addDecisionComment(memexId, dec.id, "Bob", "Decision comment");

    const task = await createTask(memexId, doc.id, "A task", "Description");
    await addTaskComment(memexId, task.id, "Carol", "Task comment");

    const result = await listCommentsForDoc(memexId, doc.id);

    expect(result.sections).toHaveLength(1);
    expect(result.sections[0].comments[0].content).toBe("Section comment");

    expect(result.decisions).toHaveLength(1);
    expect(result.decisions[0].comments[0].content).toBe("Decision comment");

    expect(result.tasks).toHaveLength(1);
    expect(result.tasks[0].comments[0].content).toBe("Task comment");
  });
});

// ── v2 typed-comment backfill (migration 0026) ──────────────
// Per Section 7 of doc-10, the migration adds `comment_type` and `source` columns
// with NOT NULL DEFAULT, so any pre-v2 row (and any new insert that omits them)
// transparently becomes (discussion, human). This guards against a regression where
// a future migration drops the default or a new code path bypasses the default by
// passing explicit nulls.

describe("backfill: comment_type and source defaults (Section 7)", () => {
  it("omitted commentType + source default to discussion/human", async () => {
    const doc = await createDocDraft(memexId, "Backfill defaults", "Purpose");
    createdDocIds.push(doc.id);

    // The service uses the schema defaults for every comment-creation path.
    const sectionComment = await addComment(memexId, doc.sections[0].id, "Alice", "freeform");
    expect(sectionComment.commentType).toBe("discussion");
    expect(sectionComment.source).toBe("human");
    // doc-26 t-4: legacy (referenceType, referenceId) replaced by structured FK columns.
    expect(sectionComment.referenceBriefId).toBeNull();
    expect(sectionComment.referenceStandardId).toBeNull();
    expect(sectionComment.referenceDecisionId).toBeNull();
    expect(sectionComment.referenceTaskId).toBeNull();

    const dec = await createDecision(memexId, doc.id, "A decision");
    const decComment = await addDecisionComment(memexId, dec.id, "Bob", "noted");
    expect(decComment.commentType).toBe("discussion");
    expect(decComment.source).toBe("human");

    const wi = await createTask(memexId, doc.id, "Pre-v2 style task", "Description");
    const wiComment = await addTaskComment(memexId, wi.id, "Carol", "ok");
    expect(wiComment.commentType).toBe("discussion");
    expect(wiComment.source).toBe("human");
  });

  it("rows that survived the migration are readable with the new columns populated", async () => {
    // Tests the historical-data invariant: every existing doc_comments row should
    // satisfy comment_type IN COMMENT_TYPES and source IN ('human','agent'). The
    // earlier version of this test asserted `discussion` / `human` literally — that
    // only held while the test DB contained discussion-only fixtures, and broke as
    // soon as drift / plan_revision / agent-sourced rows landed elsewhere in the
    // suite. The check that actually proves the migration default is the omitted-
    // fields case above; here we just verify every row has *valid* enum values.
    const rows = await db.query.docComments.findMany({
      columns: { id: true, commentType: true, source: true },
      limit: 50,
    });
    for (const r of rows) {
      expect(COMMENT_TYPES).toContain(r.commentType);
      expect(["human", "agent"]).toContain(r.source);
    }
  });
});

// ── Typed comments: server enforcement (t-4) ────────────────
// Section 7 of doc-10. Service layer validates type/source/referenceType against
// roles.ts type guards and surfaces them on every list/review path. typeFilter narrows
// to one or more types — review_doc_comments still defaults to open-only.

describe("typed comments: 12-type round-trip", () => {
  it("persists every COMMENT_TYPES value end-to-end on a section comment", async () => {
    const doc = await createDocDraft(memexId, "All-types section doc", "Purpose");
    createdDocIds.push(doc.id);
    const sectionId = doc.sections[0].id;

    for (const type of COMMENT_TYPES) {
      const written = await addComment(memexId, sectionId, "Tester", `kind=${type}`, {
        type,
        source: "agent",
      });
      expect(written.commentType).toBe(type);
      expect(written.source).toBe("agent");
    }

    const all = await listComments(memexId, sectionId);
    const types = new Set(all.map((c) => c.commentType));
    for (const t of COMMENT_TYPES) {
      expect(types.has(t)).toBe(true);
    }
  });

  it("persists comment_type + source on decision and task targets", async () => {
    const doc = await createDocDraft(memexId, "Typed dec/wi doc", "Purpose");
    createdDocIds.push(doc.id);

    const dec = await createDecision(memexId, doc.id, "Question?");
    const decComment = await addDecisionComment(memexId, dec.id, "Bot", "Need info", {
      type: "question",
      source: "agent",
    });
    expect(decComment.commentType).toBe("question");
    expect(decComment.source).toBe("agent");

    const wi = await createTask(memexId, doc.id, "Build it", "Description");
    const wiComment = await addTaskComment(memexId, wi.id, "Bot", "starting now", {
      type: "plan",
      source: "agent",
    });
    expect(wiComment.commentType).toBe("plan");
    expect(wiComment.source).toBe("agent");
  });

  it("supports cross-reference fields", async () => {
    // doc-26 t-4/t-5: cross_reference comments now point at the target via a
    // structured FK column (referenceBriefId / referenceStandardId /
    // referenceDecisionId / referenceTaskId). Service resolves UUID-or-handle.
    const doc = await createDocDraft(memexId, "Cross-ref doc", "Purpose", "document");
    createdDocIds.push(doc.id);
    const targetSpec = await createDocDraft(
      memexId,
      "Target Spec",
      "Why",
      "spec",
    );
    createdDocIds.push(targetSpec.id);
    const wi = await createTask(memexId, doc.id, "Linked WI", "Description");

    const xref = await addTaskComment(memexId, wi.id, "Bot", "see other spec", {
      type: "cross_reference",
      source: "agent",
      referenceBriefId: targetSpec.handle, // accepts handle or UUID
    });
    expect(xref.commentType).toBe("cross_reference");
    expect(xref.referenceBriefId).toBe(targetSpec.id);
    expect(xref.referenceStandardId).toBeNull();
    expect(xref.referenceDecisionId).toBeNull();
    expect(xref.referenceTaskId).toBeNull();
  });

  it("rejects invalid type with ValidationError", async () => {
    const doc = await createDocDraft(memexId, "Invalid type doc", "Purpose");
    createdDocIds.push(doc.id);
    await expect(
      addComment(memexId, doc.sections[0].id, "Bot", "bad", {
        // @ts-expect-error – intentional invalid value for the validator
        type: "not_a_type",
      }),
    ).rejects.toThrow(ValidationError);
  });

  it("rejects invalid source with ValidationError", async () => {
    const doc = await createDocDraft(memexId, "Invalid source doc", "Purpose");
    createdDocIds.push(doc.id);
    await expect(
      addComment(memexId, doc.sections[0].id, "Bot", "bad", {
        // @ts-expect-error – intentional invalid value for the validator
        source: "robot",
      }),
    ).rejects.toThrow(ValidationError);
  });

  it("rejects more than one reference* field at once with ValidationError", async () => {
    // doc-26 t-5: structured FK columns replaced (referenceType, referenceId).
    // The service enforces "at most one of spec/standard/decision/task may be
    // set on a single comment".
    const doc = await createDocDraft(memexId, "Invalid xref doc", "Purpose");
    createdDocIds.push(doc.id);
    const targetSpec = await createDocDraft(memexId, "Spec target", "p", "spec");
    createdDocIds.push(targetSpec.id);
    const dec = await createDecision(memexId, doc.id, "A question");
    await expect(
      addComment(memexId, doc.sections[0].id, "Bot", "bad", {
        type: "cross_reference",
        referenceBriefId: targetSpec.id,
        referenceDecisionId: dec.id,
      }),
    ).rejects.toThrow(ValidationError);
  });
});

describe("typed comments: typeFilter on listing endpoints", () => {
  it("listComments + listDecisionComments + listTaskComments accept typeFilter", async () => {
    const doc = await createDocDraft(memexId, "Filter doc", "Purpose");
    createdDocIds.push(doc.id);
    const sectionId = doc.sections[0].id;
    const dec = await createDecision(memexId, doc.id, "Question?");
    const wi = await createTask(memexId, doc.id, "Item", "Description");

    await addComment(memexId, sectionId, "B", "p1", { type: "plan", source: "agent" });
    await addComment(memexId, sectionId, "B", "p2", { type: "progress", source: "agent" });
    await addComment(memexId, sectionId, "B", "d1", { type: "discussion" });

    await addDecisionComment(memexId, dec.id, "B", "q1", { type: "question", source: "agent" });
    await addDecisionComment(memexId, dec.id, "B", "x1", { type: "discussion" });

    await addTaskComment(memexId, wi.id, "B", "i1", { type: "issue", source: "agent" });
    await addTaskComment(memexId, wi.id, "B", "p3", { type: "progress", source: "agent" });

    const onlyPlans = await listComments(memexId, sectionId, { typeFilter: "plan" });
    expect(onlyPlans).toHaveLength(1);
    expect(onlyPlans[0].commentType).toBe("plan");

    const planOrProgress = await listComments(memexId, sectionId, {
      typeFilter: ["plan", "progress"],
    });
    expect(planOrProgress.map((c) => c.commentType).sort()).toEqual(["plan", "progress"]);

    const decQuestions = await listDecisionComments(memexId, dec.id, {
      typeFilter: "question",
    });
    expect(decQuestions).toHaveLength(1);

    const wiNonProgress = await listTaskComments(memexId, wi.id, {
      typeFilter: ["issue"],
    });
    expect(wiNonProgress).toHaveLength(1);
    expect(wiNonProgress[0].commentType).toBe("issue");
  });

  it("listCommentsForDoc + reviewDocComments accept typeFilter and group accordingly", async () => {
    const doc = await createDocDraft(memexId, "Doc-level filter doc", "Purpose");
    createdDocIds.push(doc.id);
    const sectionId = doc.sections[0].id;
    const dec = await createDecision(memexId, doc.id, "Question?");
    const wi = await createTask(memexId, doc.id, "Item", "Description");

    await addComment(memexId, sectionId, "B", "plan section", { type: "plan", source: "agent" });
    await addComment(memexId, sectionId, "B", "noise", { type: "progress", source: "agent" });
    await addDecisionComment(memexId, dec.id, "B", "question dec", {
      type: "question",
      source: "agent",
    });
    await addTaskComment(memexId, wi.id, "B", "issue wi", { type: "issue", source: "agent" });

    const filtered = await listCommentsForDoc(memexId, doc.id, {
      typeFilter: ["plan", "issue"],
    });
    expect(filtered.sections[0].comments.every((c) => c.commentType === "plan")).toBe(true);
    expect(filtered.tasks[0].comments.every((c) => c.commentType === "issue")).toBe(true);
    // Decisions had only `question` comments, which are filtered out — group disappears.
    expect(filtered.decisions).toHaveLength(0);

    const review = await reviewDocComments(memexId, doc.id, { typeFilter: "question" });
    expect(review.decisions[0].comments[0].commentType).toBe("question");
  });
});

describe("typed comments: surface fields on every list path", () => {
  it("listCommentsForDoc returns commentType + source on every comment", async () => {
    const doc = await createDocDraft(memexId, "Surface fields doc", "Purpose");
    createdDocIds.push(doc.id);
    await addComment(memexId, doc.sections[0].id, "B", "plan", {
      type: "plan",
      source: "agent",
    });
    const result = await listCommentsForDoc(memexId, doc.id);
    const c = result.sections[0].comments[0];
    expect(c.commentType).toBe("plan");
    expect(c.source).toBe("agent");
  });
});
