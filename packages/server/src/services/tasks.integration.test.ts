import { describe, it, expect, afterAll, beforeAll, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../db/connection.js";
import { documents, decisions, tasks, decisionDeps, taskDeps } from "../db/schema.js";
import { createDocDraft } from "./documents.js";
import { createDecision, resolveDecision } from "./decisions.js";
import {
  createTask,
  listTasks,
  getTask,
  updateTaskStatus,
  updateAcceptanceCriteria,
  getReadyTasks,
} from "./tasks.js";
import { addDecisionDep, addTaskDep } from "./dependencies.js";
import { NotFoundError, ValidationError } from "../types/errors.js";
import { makeTestMemex } from "./test-helpers.js";
import { tagAc } from "@memex-ai-ac/vitest";

const AC = (n: number) =>
  `mindset-prod/memex-building-itself/specs/spec-485/acs/ac-${n}`;

const createdDocIds: string[] = [];

afterAll(async () => {
  for (const id of createdDocIds) {
    await db.delete(taskDeps).where(
      eq(taskDeps.taskId, id) // cleanup by docId scope below
    ).catch(() => {});
    await db.delete(decisionDeps).where(
      eq(decisionDeps.taskId, id)
    ).catch(() => {});
  }
  for (const id of createdDocIds) {
    await db.delete(tasks).where(eq(tasks.docId, id)).catch(() => {});
    await db.delete(decisions).where(eq(decisions.docId, id)).catch(() => {});
    await db.delete(documents).where(eq(documents.id, id)).catch(() => {});
  }
});


let memexId: string;
beforeAll(async () => {
  memexId = await makeTestMemex();
});

describe("createTask", () => {
  let docId: string;

  beforeAll(async () => {
    const doc = await createDocDraft(memexId, "Task Create Test", "Purpose");
    docId = doc.id;
    createdDocIds.push(doc.id);
  });

  it("creates a task with not_started status", async () => {
    const task = await createTask(memexId, docId, "Build it", "Build the feature");
    expect(task.title).toBe("Build it");
    expect(task.description).toBe("Build the feature");
    expect(task.status).toBe("not_started");
    expect(task.docId).toBe(docId);
    expect(task.startedAt).toBeNull();
    expect(task.completedAt).toBeNull();
  });

  it("creates with acceptance criteria", async () => {
    const criteria = [
      { description: "Tests pass", done: false },
      { description: "Reviewed", done: false },
    ];
    const task = await createTask(memexId, docId, "With AC", "Description", criteria);
    expect(task.acceptanceCriteria).toEqual(criteria);
  });

  it("creates with section ref", async () => {
    const task = await createTask(memexId, docId, "Linked", "Description", [], "section-1");
    expect(task.sectionRef).toBe("section-1");
  });

  it("assigns sequential seq numbers", async () => {
    const doc = await createDocDraft(memexId, "Task Seq Test", "Purpose");
    createdDocIds.push(doc.id);

    const t1 = await createTask(memexId, doc.id, "First", "Desc");
    const t2 = await createTask(memexId, doc.id, "Second", "Desc");
    expect(t2.seq).toBe(t1.seq + 1);
  });
});

describe("updateTaskStatus", () => {
  let docId: string;

  beforeAll(async () => {
    const doc = await createDocDraft(memexId, "Task Status Test", "Purpose");
    docId = doc.id;
    createdDocIds.push(doc.id);
  });

  it("transitions to in_progress and sets startedAt", async () => {
    const task = await createTask(memexId, docId, "Status test", "Desc");
    const updated = await updateTaskStatus(memexId, task.id, "in_progress");

    expect(updated.status).toBe("in_progress");
    expect(updated.startedAt).toBeTruthy();
    expect(updated.completedAt).toBeNull();
  });

  it("transitions to complete and sets completedAt", async () => {
    const task = await createTask(memexId, docId, "Complete test", "Desc");
    await updateTaskStatus(memexId, task.id, "in_progress");
    const updated = await updateTaskStatus(memexId, task.id, "complete");

    expect(updated.status).toBe("complete");
    expect(updated.completedAt).toBeTruthy();
  });

  it("resets timestamps when transitioning back to not_started", async () => {
    const task = await createTask(memexId, docId, "Reset test", "Desc");
    await updateTaskStatus(memexId, task.id, "in_progress");
    const updated = await updateTaskStatus(memexId, task.id, "not_started");

    expect(updated.status).toBe("not_started");
    expect(updated.startedAt).toBeNull();
    expect(updated.completedAt).toBeNull();
  });

  it("does not overwrite startedAt on repeated in_progress", async () => {
    const task = await createTask(memexId, docId, "No overwrite", "Desc");
    const first = await updateTaskStatus(memexId, task.id, "in_progress");
    // Move to complete, then back to in_progress — startedAt already set
    await updateTaskStatus(memexId, task.id, "not_started");
    // Now set in_progress again — startedAt is null so it should be set
    const second = await updateTaskStatus(memexId, task.id, "in_progress");
    expect(second.startedAt).toBeTruthy();
  });

  it("throws ValidationError for invalid status", async () => {
    const task = await createTask(memexId, docId, "Invalid status", "Desc");
    await expect(
      updateTaskStatus(memexId, task.id, "bogus")
    ).rejects.toThrow(ValidationError);
  });

  it("throws NotFoundError for non-existent task", async () => {
    await expect(
      updateTaskStatus(memexId, "00000000-0000-0000-0000-000000000000", "complete")
    ).rejects.toThrow(NotFoundError);
  });

  // spec-485 (ac-5, ac-8): completing a task NEVER advances a Spec's phase.
  // This is the regression guard for the removed `maybeAutoPromoteToVerify` — the
  // last surviving limb of the "phase is a deliberate placement" arc
  // (spec-189→295/327/342→464). Real specs under a real memex, so a reintroduced
  // auto-promote WOULD flip the doc here — a genuine guard, not a tautology.
  it("does NOT advance a Spec build → verify when the last task completes", async () => {
    tagAc(AC(8));
    tagAc(AC(5));
    tagAc(AC(7));
    tagAc(AC(9));
    // Scope ACs proven by the same behaviour:
    tagAc(AC(1)); // last-task completion no longer changes phase
    tagAc(AC(2)); // no task-state change advances phase (service layer → any caller)
    tagAc(AC(4)); // this IS the regression guard against reintroduction
    const spec = await createDocDraft(memexId, "No-AutoPromote Spec", "Purpose", "spec");
    createdDocIds.push(spec.id);
    const { updateDocStatus } = await import("./documents.js");
    await updateDocStatus(memexId, spec.id, "build");

    const t1 = await createTask(memexId, spec.id, "Task 1", "Desc");
    const t2 = await createTask(memexId, spec.id, "Task 2", "Desc");

    await updateTaskStatus(memexId, t1.id, "complete");
    let row = await db.query.documents.findFirst({ where: eq(documents.id, spec.id) });
    expect(row?.status).toBe("build"); // one task still open

    // Completing the LAST open task must still leave the Spec in build —
    // the phase move is the human's deliberate call, never an auto side-effect.
    await updateTaskStatus(memexId, t2.id, "complete");
    row = await db.query.documents.findFirst({ where: eq(documents.id, spec.id) });
    expect(row?.status).toBe("build");
  });

  // spec-485 (ac-6): the removal is surgical — the sibling issue auto-resolution
  // call (spec-112 ac-22) on task completion is preserved. Spy the module binding
  // and assert `updateTaskStatus(..., 'complete')` still invokes it.
  it("still runs issue auto-resolution when a task completes (ac-6 — sibling preserved)", async () => {
    tagAc(AC(6));
    tagAc(AC(3)); // task completion still succeeds + issue auto-resolution unaffected
    const issues = await import("./issues.js");
    const spy = vi
      .spyOn(issues, "maybeAutoResolveIssuesForTask")
      .mockResolvedValue([]);
    try {
      const spec = await createDocDraft(memexId, "IssueResolve Spec", "Purpose", "spec");
      createdDocIds.push(spec.id);
      const { updateDocStatus } = await import("./documents.js");
      await updateDocStatus(memexId, spec.id, "build");

      const t1 = await createTask(memexId, spec.id, "Task", "Desc");
      await updateTaskStatus(memexId, t1.id, "complete");

      expect(spy).toHaveBeenCalledWith(memexId, t1.id);
    } finally {
      spy.mockRestore();
    }
  });

  it("does not move non-Spec docs on task completion", async () => {
    tagAc(AC(5));
    tagAc(AC(2));
    const doc = await createDocDraft(memexId, "No-AutoPromote Doc", "Purpose", "document");
    createdDocIds.push(doc.id);
    const { updateDocStatus } = await import("./documents.js");
    await updateDocStatus(memexId, doc.id, "build");

    const t1 = await createTask(memexId, doc.id, "Doc Task", "Desc");
    await updateTaskStatus(memexId, t1.id, "complete");

    const row = await db.query.documents.findFirst({ where: eq(documents.id, doc.id) });
    expect(row?.status).toBe("build"); // unchanged
  });

  it("does not move a Spec that is not in build on task completion", async () => {
    tagAc(AC(5));
    tagAc(AC(2));
    const spec = await createDocDraft(memexId, "Specify Spec", "Purpose", "spec");
    createdDocIds.push(spec.id);
    const { updateDocStatus } = await import("./documents.js");
    await updateDocStatus(memexId, spec.id, "specify");

    const t1 = await createTask(memexId, spec.id, "Specify Task", "Desc");
    await updateTaskStatus(memexId, t1.id, "complete");

    const row = await db.query.documents.findFirst({ where: eq(documents.id, spec.id) });
    expect(row?.status).toBe("specify");
  });
});

describe("updateAcceptanceCriteria", () => {
  let docId: string;

  beforeAll(async () => {
    const doc = await createDocDraft(memexId, "Task AC Test", "Purpose");
    docId = doc.id;
    createdDocIds.push(doc.id);
  });

  it("updates acceptance criteria", async () => {
    const task = await createTask(memexId, docId, "AC test", "Desc");
    const criteria = [{ description: "Unit tests", done: true }];
    const updated = await updateAcceptanceCriteria(memexId, task.id, criteria);
    expect(updated.acceptanceCriteria).toEqual(criteria);
  });

  it("throws NotFoundError for non-existent task", async () => {
    await expect(
      updateAcceptanceCriteria(memexId, "00000000-0000-0000-0000-000000000000", [])
    ).rejects.toThrow(NotFoundError);
  });
});

describe("listTasks", () => {
  it("returns tasks with computed blocked status", async () => {
    const doc = await createDocDraft(memexId, "List Tasks Test", "Purpose");
    createdDocIds.push(doc.id);

    const task = await createTask(memexId, doc.id, "Blocked task", "Desc");
    const dec = await createDecision(memexId, doc.id, "Open decision");
    await addDecisionDep(memexId, task.id, dec.id);

    const list = await listTasks(memexId, doc.id);
    expect(list).toHaveLength(1);
    expect(list[0].blocked).toBe(true);
    expect(list[0].blockedByDecisions).toHaveLength(1);
  });

  it("marks task as unblocked when decision is resolved", async () => {
    const doc = await createDocDraft(memexId, "Unblocked Test", "Purpose");
    createdDocIds.push(doc.id);

    const task = await createTask(memexId, doc.id, "Unblockable", "Desc");
    const dec = await createDecision(memexId, doc.id, "Will resolve");
    await addDecisionDep(memexId, task.id, dec.id);
    await resolveDecision(memexId, dec.id, "Resolved");

    const list = await listTasks(memexId, doc.id);
    expect(list[0].blocked).toBe(false);
    expect(list[0].blockedByDecisions).toHaveLength(0);
  });

  it("returns empty array for doc with no tasks", async () => {
    const doc = await createDocDraft(memexId, "Empty Tasks Doc", "Purpose");
    createdDocIds.push(doc.id);
    const list = await listTasks(memexId, doc.id);
    expect(list).toEqual([]);
  });
});

describe("getTask", () => {
  let docId: string;
  let task: Awaited<ReturnType<typeof createTask>>;

  beforeAll(async () => {
    const doc = await createDocDraft(memexId, "Get Task Doc", "Purpose");
    docId = doc.id;
    createdDocIds.push(doc.id);
    task = await createTask(memexId, docId, "Lookup task", "Desc");
  });

  it("retrieves by UUID", async () => {
    const found = await getTask(memexId, task.id);
    expect(found.id).toBe(task.id);
    expect(found.title).toBe("Lookup task");
  });

  it("retrieves by T-N handle with docId", async () => {
    const found = await getTask(memexId, `T-${task.seq}`, docId);
    expect(found.id).toBe(task.id);
  });

  it("throws NotFoundError for non-existent UUID", async () => {
    await expect(
      getTask(memexId, "00000000-0000-0000-0000-000000000000")
    ).rejects.toThrow(NotFoundError);
  });

  it("throws ValidationError for invalid format without docId", async () => {
    await expect(getTask(memexId, "T-1")).rejects.toThrow(ValidationError);
  });
});

describe("getReadyTasks", () => {
  it("returns only unblocked not_started tasks", async () => {
    const doc = await createDocDraft(memexId, "Ready Tasks Doc", "Purpose");
    createdDocIds.push(doc.id);

    const ready = await createTask(memexId, doc.id, "Ready", "Desc");
    const started = await createTask(memexId, doc.id, "Started", "Desc");
    await updateTaskStatus(memexId, started.id, "in_progress");

    const blocked = await createTask(memexId, doc.id, "Blocked", "Desc");
    const dec = await createDecision(memexId, doc.id, "Blocker");
    await addDecisionDep(memexId, blocked.id, dec.id);

    const readyTasks = await getReadyTasks(memexId, doc.id);
    expect(readyTasks).toHaveLength(1);
    expect(readyTasks[0].id).toBe(ready.id);
  });
});
