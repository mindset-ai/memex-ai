import { eq, and, inArray } from "drizzle-orm";
import { db } from "../db/connection.js";
import {
  decisions,
  tasks,
  decisionDeps,
  taskDeps,
} from "../db/schema.js";
import type { Decision, Task } from "../db/schema.js";
import { NotFoundError, ValidationError } from "../types/errors.js";
import { mutate, type Mutated } from "./mutate.js";

export interface Blockers {
  decisions: Decision[];
  tasks: Task[];
}

// Dependency edges (junction tables) inherit account scope from the parent task. All
// operations require memexId and verify both endpoints belong to the same account before
// inserting. Cross-account dependency creation surfaces as 404.
//
// Per dec-11 (doc-10), the legacy "both ends must live in the same document" constraint has
// been removed: a task in Spec A may legitimately depend on a decision (or another
// task) in Spec B once Specs are linked via parent_doc_id. Account scope is
// the only structural guard.
export async function addDecisionDep(
  memexId: string,
  taskId: string,
  decisionId: string
): Promise<Mutated<void>> {
  const item = await db.query.tasks.findFirst({
    where: and(eq(tasks.id, taskId), eq(tasks.memexId, memexId)),
  });
  if (!item) throw new NotFoundError(`Task ${taskId} not found`);

  const dec = await db.query.decisions.findFirst({
    where: and(eq(decisions.id, decisionId), eq(decisions.memexId, memexId)),
  });
  if (!dec) throw new NotFoundError(`Decision ${decisionId} not found`);

  return mutate(
    {},
    { memexId, docId: item.docId, entity: "dependency", action: "created" },
    async () => {
      await db
        .insert(decisionDeps)
        .values({ taskId, decisionId })
        .onConflictDoNothing();
    },
  );
}

export async function removeDecisionDep(
  memexId: string,
  taskId: string,
  decisionId: string
): Promise<Mutated<void>> {
  const item = await db.query.tasks.findFirst({
    where: and(eq(tasks.id, taskId), eq(tasks.memexId, memexId)),
  });

  // Preserve existing behavior: if `item` isn't found in this memex the delete
  // still runs (it matches no rows under that memex's tasks anyway) but no emit
  // fires — silent: true keeps the type-brand consistent.
  if (!item) {
    return mutate(
      {},
      { memexId, entity: "dependency", action: "deleted" },
      async () => {
        await db
          .delete(decisionDeps)
          .where(
            and(
              eq(decisionDeps.taskId, taskId),
              eq(decisionDeps.decisionId, decisionId)
            )
          );
      },
      { silent: true },
    );
  }

  return mutate(
    {},
    { memexId, docId: item.docId, entity: "dependency", action: "deleted" },
    async () => {
      await db
        .delete(decisionDeps)
        .where(
          and(
            eq(decisionDeps.taskId, taskId),
            eq(decisionDeps.decisionId, decisionId)
          )
        );
    },
  );
}

export async function addTaskDep(
  memexId: string,
  taskId: string,
  dependsOnId: string
): Promise<Mutated<void>> {
  if (taskId === dependsOnId) {
    throw new ValidationError("A task cannot depend on itself");
  }

  const item = await db.query.tasks.findFirst({
    where: and(eq(tasks.id, taskId), eq(tasks.memexId, memexId)),
  });
  if (!item) throw new NotFoundError(`Task ${taskId} not found`);

  const dep = await db.query.tasks.findFirst({
    where: and(eq(tasks.id, dependsOnId), eq(tasks.memexId, memexId)),
  });
  if (!dep) throw new NotFoundError(`Task ${dependsOnId} not found`);

  return mutate(
    {},
    { memexId, docId: item.docId, entity: "dependency", action: "created" },
    async () => {
      await db
        .insert(taskDeps)
        .values({ taskId, dependsOnId })
        .onConflictDoNothing();
    },
  );
}

export async function removeTaskDep(
  memexId: string,
  taskId: string,
  dependsOnId: string
): Promise<Mutated<void>> {
  const item = await db.query.tasks.findFirst({
    where: and(eq(tasks.id, taskId), eq(tasks.memexId, memexId)),
  });

  if (!item) {
    return mutate(
      {},
      { memexId, entity: "dependency", action: "deleted" },
      async () => {
        await db
          .delete(taskDeps)
          .where(
            and(
              eq(taskDeps.taskId, taskId),
              eq(taskDeps.dependsOnId, dependsOnId)
            )
          );
      },
      { silent: true },
    );
  }

  return mutate(
    {},
    { memexId, docId: item.docId, entity: "dependency", action: "deleted" },
    async () => {
      await db
        .delete(taskDeps)
        .where(
          and(
            eq(taskDeps.taskId, taskId),
            eq(taskDeps.dependsOnId, dependsOnId)
          )
        );
    },
  );
}

// Inverse direction (t-9 / get_decision_impact): given a decision, list every task
// that depends on it. Account scope is enforced — tasks in other accounts can never
// surface here even if a stolen UUID is passed in. Cross-doc edges within the account are
// allowed (per dec-11) and returned.
export async function getTasksBlockedByDecision(
  memexId: string,
  decisionId: string,
): Promise<Task[]> {
  const edges = await db
    .select({ taskId: decisionDeps.taskId })
    .from(decisionDeps)
    .where(eq(decisionDeps.decisionId, decisionId));
  if (edges.length === 0) return [];
  const ids = edges.map((e) => e.taskId);
  return db
    .select()
    .from(tasks)
    .where(and(inArray(tasks.id, ids), eq(tasks.memexId, memexId)));
}

export async function getBlockersForTask(
  memexId: string,
  taskId: string
): Promise<Blockers> {
  // Account scope is enforced by the caller (tasks.ts only calls this after verifying
  // the task belongs to the account). The task_deps and decision_deps tables
  // inherit scope.
  void memexId;
  const decDeps = await db
    .select({ decisionId: decisionDeps.decisionId })
    .from(decisionDeps)
    .where(eq(decisionDeps.taskId, taskId));

  const wDeps = await db
    .select({ dependsOnId: taskDeps.dependsOnId })
    .from(taskDeps)
    .where(eq(taskDeps.taskId, taskId));

  const blockerDecisions =
    decDeps.length > 0
      ? await db
          .select()
          .from(decisions)
          .where(
            inArray(
              decisions.id,
              decDeps.map((d) => d.decisionId)
            )
          )
      : [];

  const blockerTasks =
    wDeps.length > 0
      ? await db
          .select()
          .from(tasks)
          .where(
            inArray(
              tasks.id,
              wDeps.map((d) => d.dependsOnId)
            )
          )
      : [];

  return { decisions: blockerDecisions, tasks: blockerTasks };
}

export async function getBlockingGraphForDoc(
  memexId: string,
  docId: string
): Promise<Map<string, Blockers>> {
  // Get all tasks for this doc (scoped to account)
  const allItems = await db
    .select()
    .from(tasks)
    .where(and(eq(tasks.docId, docId), eq(tasks.memexId, memexId)));

  if (allItems.length === 0) return new Map();

  const itemIds = allItems.map((w) => w.id);

  // Get all decision deps for these tasks
  const allDecDeps = await db
    .select()
    .from(decisionDeps)
    .where(inArray(decisionDeps.taskId, itemIds));

  // Get all work-item deps
  const allTaskDeps = await db
    .select()
    .from(taskDeps)
    .where(inArray(taskDeps.taskId, itemIds));

  // Get all referenced decisions (may include cross-doc decisions per dec-11, so we
  // deliberately do NOT filter by docId here).
  const decIds = [...new Set(allDecDeps.map((d) => d.decisionId))];
  const referencedDecisions =
    decIds.length > 0
      ? await db
          .select()
          .from(decisions)
          .where(inArray(decisions.id, decIds))
      : [];

  // Get all referenced tasks (may also be cross-doc per dec-11).
  const refItemIds = [...new Set(allTaskDeps.map((d) => d.dependsOnId))];
  const referencedTasks =
    refItemIds.length > 0
      ? await db
          .select()
          .from(tasks)
          .where(inArray(tasks.id, refItemIds))
      : [];

  const decMap = new Map(referencedDecisions.map((d) => [d.id, d]));
  const itemMap = new Map([
    ...allItems.map((w) => [w.id, w] as const),
    ...referencedTasks.map((w) => [w.id, w] as const),
  ]);

  // Build the graph
  const graph = new Map<string, Blockers>();
  for (const w of allItems) {
    const blockerDecs = allDecDeps
      .filter((d) => d.taskId === w.id)
      .map((d) => decMap.get(d.decisionId)!)
      .filter(Boolean);

    const blockerTasks = allTaskDeps
      .filter((d) => d.taskId === w.id)
      .map((d) => itemMap.get(d.dependsOnId)!)
      .filter(Boolean);

    graph.set(w.id, { decisions: blockerDecs, tasks: blockerTasks });
  }

  return graph;
}
