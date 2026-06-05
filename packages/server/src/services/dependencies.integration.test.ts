import { describe, it, expect, afterAll, beforeAll } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../db/connection.js";
import { documents, decisions, tasks, decisionDeps, taskDeps } from "../db/schema.js";
import { createDocDraft } from "./documents.js";
import { createDecision } from "./decisions.js";
import { createTask } from "./tasks.js";
import {
  addDecisionDep,
  removeDecisionDep,
  addTaskDep,
  removeTaskDep,
  getBlockersForTask,
  getBlockingGraphForDoc,
} from "./dependencies.js";
import { NotFoundError, ValidationError } from "../types/errors.js";
import { makeTestMemex } from "./test-helpers.js";

const createdDocIds: string[] = [];

afterAll(async () => {
  for (const id of createdDocIds) {
    await db.delete(taskDeps).where(eq(taskDeps.taskId, id)).catch(() => {});
    await db.delete(decisionDeps).where(eq(decisionDeps.taskId, id)).catch(() => {});
    await db.delete(tasks).where(eq(tasks.docId, id)).catch(() => {});
    await db.delete(decisions).where(eq(decisions.docId, id)).catch(() => {});
    await db.delete(documents).where(eq(documents.id, id)).catch(() => {});
  }
});


let memexId: string;
beforeAll(async () => {
  memexId = await makeTestMemex();
});

describe("addDecisionDep", () => {
  let docId: string;

  beforeAll(async () => {
    const doc = await createDocDraft(memexId, "Decision Dep Test", "Purpose");
    docId = doc.id;
    createdDocIds.push(doc.id);
  });

  it("adds a dependency between task and decision", async () => {
    const task = await createTask(memexId, docId, "Task", "Desc");
    const dec = await createDecision(memexId, docId, "Decision");

    await addDecisionDep(memexId, task.id, dec.id);

    const blockers = await getBlockersForTask(memexId, task.id);
    expect(blockers.decisions).toHaveLength(1);
    expect(blockers.decisions[0].id).toBe(dec.id);
  });

  it("is idempotent (duplicate add does not error)", async () => {
    const task = await createTask(memexId, docId, "Idempotent", "Desc");
    const dec = await createDecision(memexId, docId, "Dup dec");

    await addDecisionDep(memexId, task.id, dec.id);
    await addDecisionDep(memexId, task.id, dec.id); // should not throw

    const blockers = await getBlockersForTask(memexId, task.id);
    expect(blockers.decisions).toHaveLength(1);
  });

  it("throws NotFoundError for non-existent task", async () => {
    const dec = await createDecision(memexId, docId, "Orphan dec");
    await expect(
      addDecisionDep(memexId, "00000000-0000-0000-0000-000000000000", dec.id)
    ).rejects.toThrow(NotFoundError);
  });

  it("throws NotFoundError for non-existent decision", async () => {
    const task = await createTask(memexId, docId, "Orphan task", "Desc");
    await expect(
      addDecisionDep(memexId, task.id, "00000000-0000-0000-0000-000000000000")
    ).rejects.toThrow(NotFoundError);
  });

  it("allows cross-document task→decision edges (per dec-11)", async () => {
    const doc2 = await createDocDraft(memexId, "Other Doc", "Purpose");
    createdDocIds.push(doc2.id);

    const task = await createTask(memexId, docId, "Doc1 task", "Desc");
    const dec = await createDecision(memexId, doc2.id, "Doc2 decision");

    // Should succeed: dec-11 dropped the same-doc constraint for dependency edges.
    await addDecisionDep(memexId, task.id, dec.id);

    const blockers = await getBlockersForTask(memexId, task.id);
    expect(blockers.decisions).toHaveLength(1);
    expect(blockers.decisions[0].id).toBe(dec.id);
  });
});

describe("removeDecisionDep", () => {
  it("removes a dependency", async () => {
    const doc = await createDocDraft(memexId, "Remove DecDep Test", "Purpose");
    createdDocIds.push(doc.id);

    const task = await createTask(memexId, doc.id, "Task", "Desc");
    const dec = await createDecision(memexId, doc.id, "Decision");

    await addDecisionDep(memexId, task.id, dec.id);
    await removeDecisionDep(memexId, task.id, dec.id);

    const blockers = await getBlockersForTask(memexId, task.id);
    expect(blockers.decisions).toHaveLength(0);
  });
});

describe("addTaskDep", () => {
  let docId: string;

  beforeAll(async () => {
    const doc = await createDocDraft(memexId, "Task Dep Test", "Purpose");
    docId = doc.id;
    createdDocIds.push(doc.id);
  });

  it("adds a task-to-task dependency", async () => {
    const task1 = await createTask(memexId, docId, "Task 1", "Desc");
    const task2 = await createTask(memexId, docId, "Task 2", "Desc");

    await addTaskDep(memexId, task1.id, task2.id);

    const blockers = await getBlockersForTask(memexId, task1.id);
    expect(blockers.tasks).toHaveLength(1);
    expect(blockers.tasks[0].id).toBe(task2.id);
  });

  it("throws ValidationError for self-dependency", async () => {
    const task = await createTask(memexId, docId, "Self dep", "Desc");
    await expect(addTaskDep(memexId, task.id, task.id)).rejects.toThrow(ValidationError);
  });

  it("allows cross-document work-item→work-item edges (per dec-11)", async () => {
    const doc2 = await createDocDraft(memexId, "Other Doc 2", "Purpose");
    createdDocIds.push(doc2.id);

    const task1 = await createTask(memexId, docId, "Doc1 task", "Desc");
    const task2 = await createTask(memexId, doc2.id, "Doc2 task", "Desc");

    await addTaskDep(memexId, task1.id, task2.id);

    const blockers = await getBlockersForTask(memexId, task1.id);
    expect(blockers.tasks).toHaveLength(1);
    expect(blockers.tasks[0].id).toBe(task2.id);
  });
});

describe("removeTaskDep", () => {
  it("removes a task dependency", async () => {
    const doc = await createDocDraft(memexId, "Remove TaskDep Test", "Purpose");
    createdDocIds.push(doc.id);

    const task1 = await createTask(memexId, doc.id, "T1", "Desc");
    const task2 = await createTask(memexId, doc.id, "T2", "Desc");

    await addTaskDep(memexId, task1.id, task2.id);
    await removeTaskDep(memexId, task1.id, task2.id);

    const blockers = await getBlockersForTask(memexId, task1.id);
    expect(blockers.tasks).toHaveLength(0);
  });
});

describe("getBlockersForTask", () => {
  it("returns empty blockers for task with no dependencies", async () => {
    const doc = await createDocDraft(memexId, "No Blockers Test", "Purpose");
    createdDocIds.push(doc.id);

    const task = await createTask(memexId, doc.id, "Unblocked", "Desc");
    const blockers = await getBlockersForTask(memexId, task.id);

    expect(blockers.decisions).toHaveLength(0);
    expect(blockers.tasks).toHaveLength(0);
  });

  it("returns mixed decision and task blockers", async () => {
    const doc = await createDocDraft(memexId, "Mixed Blockers Test", "Purpose");
    createdDocIds.push(doc.id);

    const task = await createTask(memexId, doc.id, "Main task", "Desc");
    const dec = await createDecision(memexId, doc.id, "Blocking dec");
    const dep = await createTask(memexId, doc.id, "Blocking task", "Desc");

    await addDecisionDep(memexId, task.id, dec.id);
    await addTaskDep(memexId, task.id, dep.id);

    const blockers = await getBlockersForTask(memexId, task.id);
    expect(blockers.decisions).toHaveLength(1);
    expect(blockers.tasks).toHaveLength(1);
  });
});

describe("getBlockingGraphForDoc", () => {
  it("returns empty map for doc with no tasks", async () => {
    const doc = await createDocDraft(memexId, "Empty Graph Test", "Purpose");
    createdDocIds.push(doc.id);

    const graph = await getBlockingGraphForDoc(memexId, doc.id);
    expect(graph.size).toBe(0);
  });

  it("builds complete blocking graph for doc", async () => {
    const doc = await createDocDraft(memexId, "Graph Test", "Purpose");
    createdDocIds.push(doc.id);

    const t1 = await createTask(memexId, doc.id, "Task 1", "Desc");
    const t2 = await createTask(memexId, doc.id, "Task 2", "Desc");
    const dec = await createDecision(memexId, doc.id, "Decision");

    await addDecisionDep(memexId, t1.id, dec.id);
    await addTaskDep(memexId, t2.id, t1.id);

    const graph = await getBlockingGraphForDoc(memexId, doc.id);
    expect(graph.size).toBe(2);

    const t1Blockers = graph.get(t1.id)!;
    expect(t1Blockers.decisions).toHaveLength(1);
    expect(t1Blockers.tasks).toHaveLength(0);

    const t2Blockers = graph.get(t2.id)!;
    expect(t2Blockers.decisions).toHaveLength(0);
    expect(t2Blockers.tasks).toHaveLength(1);
  });
});
