import { and, eq, asc, isNull } from "drizzle-orm";
import { db } from "../db/connection.js";
import { tasks, documents } from "../db/schema.js";
import type { Task, Decision } from "../db/schema.js";
import { ConflictError, NotFoundError, ValidationError } from "../types/errors.js";
import { TASK_STATUSES, isTaskStatus } from "../types/roles.js";
import { mutate, type Mutated, type RequestCtx } from "./mutate.js";
import { resolveActorColumns } from "./actor.js";
import { getBlockersForTask, getBlockingGraphForDoc } from "./dependencies.js";
import type { Blockers } from "./dependencies.js";
import { nextSeq, withSeqRetry } from "./shared/sequence.js";
import { isUuid, parseHandle } from "./shared/identifiers.js";
import { docAttribution } from "./shared/doc-attribution.js";
import { maybeAutoResolveIssuesForTask } from "./issues.js";

// Per doc-37: bare `T-N` handles can collide within a memex because `tasks.seq` is
// per-doc, not per-memex. When a caller uses a bare handle that matches multiple rows
// we throw this — mirrors AmbiguousDecisionHandleError. Callers pass a parent doc id
// (via resolveRef's parentDocId) to disambiguate, or use a UUID.
export class AmbiguousTaskHandleError extends ConflictError {
  readonly candidates: string[];
  constructor(handle: string, candidates: string[]) {
    super(
      `Task handle ${handle} is ambiguous; ${candidates.length} matches in this memex.`,
      "AMBIGUOUS_TASK_HANDLE",
    );
    this.candidates = candidates;
  }
}

export function qualifiedTaskHandle(
  parentDocHandle: string,
  taskSeq: number,
): string {
  return `${parentDocHandle}:T-${taskSeq}`;
}

// Returns the parent doc's type (spec-306) and lifecycle status (spec-327) so
// createTask can attribute the task.created outcome event to its Spec AND apply
// the build/verify-phase gate without a second query — this assert already loads the row.
async function assertDocInAccount(
  memexId: string,
  docId: string,
): Promise<{ docType: string; status: string }> {
  const doc = await db.query.documents.findFirst({
    where: and(eq(documents.id, docId), eq(documents.memexId, memexId)),
  });
  if (!doc) throw new NotFoundError(`Document ${docId} not found`);
  return { docType: doc.docType, status: doc.status };
}

export interface TaskWithBlockers extends Task {
  blocked: boolean;
  blockedByDecisions: Decision[];
  blockedByTasks: Task[];
}

function attachBlockedStatus(item: Task, blockers: Blockers): TaskWithBlockers {
  const blockedByDecisions = blockers.decisions.filter(
    (d) => d.status === "open"
  );
  const blockedByTasks = blockers.tasks.filter(
    (w) => w.status !== "complete"
  );
  return {
    ...item,
    blocked: blockedByDecisions.length > 0 || blockedByTasks.length > 0,
    blockedByDecisions,
    blockedByTasks,
  };
}

export interface AcceptanceCriterion {
  description: string;
  done: boolean;
}

export async function createTask(
  memexId: string,
  docId: string,
  title: string,
  description: string,
  acceptanceCriteria?: AcceptanceCriterion[],
  sectionRef?: string,
  ctx: RequestCtx = {}
): Promise<Mutated<Task>> {
  const { docType } = await assertDocInAccount(memexId, docId);
  // spec-464 dec-9: the create_task phase guard (spec-327) is REMOVED — the
  // phase gate at the tool seam (services/phase-gate.ts) now refuses create_task
  // ahead of build (draft/specify) for both agent channels, with a teaching
  // message from the scaffold catalog, and reopen-first on a done Spec. rest_ui
  // and ctx-less seed/server calls never route through the seam, so they remain
  // exempt exactly as before. One gate for the whole task/build tool set.
  // b-38 F-3 — wrap allocator + insert in withSeqRetry so concurrent createTask
  // calls under the same doc don't 23505 on `tasks_doc_id_seq_unique`.
  return mutate(
    ctx,
    // spec-306 dec-2: attribute the task.created outcome to its parent Spec.
    { memexId, docId, entity: "task", action: "created", payload: docAttribution(docId, docType) },
    async () =>
      withSeqRetry(
        async () => {
          const seq = await nextSeq(tasks, tasks.seq, tasks.docId, docId);
          const [item] = await db
            .insert(tasks)
            .values({
              memexId,
              docId,
              seq,
              title,
              description,
              acceptanceCriteria: acceptanceCriteria ?? [],
              sectionRef: sectionRef ?? null,
              status: "not_started",
              // spec-122 dec-2/dec-5 — stamp WHO + HOW at write time (ac-20).
              ...(await resolveActorColumns(ctx)),
            })
            .returning();
          return item;
        },
        "tasks_doc_id_seq_unique",
      ),
  );
}

export async function updateAcceptanceCriteria(
  memexId: string,
  id: string,
  criteria: AcceptanceCriterion[]
): Promise<Mutated<Task>> {
  const item = await db.query.tasks.findFirst({
    where: and(eq(tasks.id, id), eq(tasks.memexId, memexId)),
  });
  if (!item) {
    throw new NotFoundError(`Task ${id} not found`);
  }

  return mutate(
    {},
    { memexId, docId: item.docId, entity: "task", action: "updated" },
    async () => {
      const [updated] = await db
        .update(tasks)
        .set({ acceptanceCriteria: criteria })
        .where(and(eq(tasks.id, id), eq(tasks.memexId, memexId)))
        .returning();
      return updated;
    },
  );
}

export async function listTasks(
  memexId: string,
  docId: string
): Promise<TaskWithBlockers[]> {
  // spec-448 (gap closure, ac-18): exclude tasks a version cut left behind
  // (retired_at_version stamped) from the live read — they still render when
  // viewing the version they were retired at (getVersionSnapshot).
  const items = await db
    .select()
    .from(tasks)
    .where(and(eq(tasks.docId, docId), eq(tasks.memexId, memexId), isNull(tasks.retiredAtVersion)))
    .orderBy(asc(tasks.seq));

  const graph = await getBlockingGraphForDoc(memexId, docId);

  return items.map((item) => {
    const blockers = graph.get(item.id) ?? { decisions: [], tasks: [] };
    return attachBlockedStatus(item, blockers);
  });
}

/**
 * Resolve a `T-N` handle to a Task. Per doc-37: handle seq is per-doc, not per-memex,
 * so bare-handle lookups can collide across Specs. Mirrors `getDecisionByHandle`:
 *
 *  - When `parentDocId` is provided the lookup is scoped to that doc — handles are
 *    unique within a doc, so the result is unambiguous.
 *  - Without `parentDocId`, search the whole memex. Zero matches → NotFoundError.
 *    Multiple matches → AmbiguousTaskHandleError carrying qualified candidate
 *    handles so callers can pick one.
 *
 * Callers should pass the parent doc when known (resolveRef in mcp/tool-specs.ts
 * already plumbs it through) or use a UUID for unambiguous mutation.
 */
export async function getTaskByHandle(
  memexId: string,
  handle: string,
  parentDocId?: string,
): Promise<Task> {
  const seqNum = parseHandle(handle, "T-");
  if (seqNum === null) {
    throw new ValidationError(
      `Invalid task handle: ${handle}. Expected T-N format.`,
    );
  }

  const conditions = [eq(tasks.memexId, memexId), eq(tasks.seq, seqNum)];
  if (parentDocId !== undefined) {
    conditions.push(eq(tasks.docId, parentDocId));
  }

  const matches = await db
    .select({
      id: tasks.id,
      docHandle: documents.handle,
      seq: tasks.seq,
    })
    .from(tasks)
    .innerJoin(documents, eq(tasks.docId, documents.id))
    .where(and(...conditions));

  if (matches.length === 0) {
    throw new NotFoundError(`Task ${handle} not found`);
  }

  if (matches.length > 1) {
    const candidates = matches
      .map((m) => qualifiedTaskHandle(m.docHandle, m.seq))
      .sort();
    throw new AmbiguousTaskHandleError(handle, candidates);
  }

  const item = await db.query.tasks.findFirst({
    where: and(eq(tasks.id, matches[0].id), eq(tasks.memexId, memexId)),
  });
  if (!item) {
    throw new NotFoundError(`Task ${handle} not found`);
  }
  return item;
}

export async function getTask(
  memexId: string,
  idOrHandle: string,
  docId?: string
): Promise<TaskWithBlockers> {
  const seqNum = parseHandle(idOrHandle, "T-");
  let item: Task | undefined;

  if (seqNum !== null && docId) {
    item = await db.query.tasks.findFirst({
      where: (t, { and, eq: e }) =>
        and(e(t.docId, docId), e(t.seq, seqNum), e(t.memexId, memexId)),
    });
  } else if (isUuid(idOrHandle)) {
    item = await db.query.tasks.findFirst({
      where: and(eq(tasks.id, idOrHandle), eq(tasks.memexId, memexId)),
    });
  } else {
    throw new ValidationError(
      `Invalid task identifier: ${idOrHandle}. Use a UUID or T-N format with a docId.`
    );
  }

  if (!item) {
    throw new NotFoundError(`Task ${idOrHandle} not found`);
  }

  const blockers = await getBlockersForTask(memexId, item.id);
  return attachBlockedStatus(item, blockers);
}

export async function updateTaskStatus(
  memexId: string,
  id: string,
  status: string,
  ctx: RequestCtx = {}
): Promise<Mutated<Task>> {
  if (!isTaskStatus(status)) {
    throw new ValidationError(
      `Invalid status '${status}'. Must be one of: ${TASK_STATUSES.join(", ")}`
    );
  }

  const item = await db.query.tasks.findFirst({
    where: and(eq(tasks.id, id), eq(tasks.memexId, memexId)),
  });

  if (!item) {
    throw new NotFoundError(`Task ${id} not found`);
  }

  const now = new Date();
  // spec-122 dec-2/dec-5 — re-attribute on status move (who advanced it).
  const updates: Partial<Task> = { status, ...(await resolveActorColumns(ctx)) };

  if (status === "in_progress" && !item.startedAt) {
    updates.startedAt = now;
  }
  if (status === "complete") {
    updates.completedAt = now;
  }
  if (status === "not_started") {
    updates.startedAt = null;
    updates.completedAt = null;
  }

  const updated = await mutate(
    ctx,
    { memexId, docId: item.docId, entity: "task", action: "updated" },
    async () => {
      const [row] = await db
        .update(tasks)
        .set(updates)
        .where(and(eq(tasks.id, id), eq(tasks.memexId, memexId)))
        .returning();
      return row;
    },
  );

  // spec-485 (dec-1): completing a task NEVER moves a Spec's phase. Phase is a
  // deliberate human/handoff placement, not inferred from code-work. Completing the
  // last open task used to auto-promote build→verify (the former
  // `maybeAutoPromoteToVerify`) — the last surviving limb of the arc
  // spec-189→295/327/342→464, now removed. The explicit "that was the last task →
  // move to verify" prompt lives in a SEPARATE path (the `task_completed` footer
  // signal in agent/handlers/tasks.ts) and remains the deliberate signal.
  if (status === "complete") {
    // spec-112 ac-22: a `converted` Issue whose satisfying Task just completed
    // transitions → `resolved` IFF the verifying AC's latest test_event is a pass.
    // Best-effort: a failure here must not fail the task-status write (the Issue
    // simply stays `converted` until the AC goes green or the next trigger fires).
    await maybeAutoResolveIssuesForTask(memexId, item.id).catch(() => {});
  }
  return updated;
}

export async function updateTask(
  memexId: string,
  id: string,
  updates: {
    title?: string;
    description?: string;
    acceptanceCriteria?: AcceptanceCriterion[];
    sectionRef?: string | null;
  },
  ctx: RequestCtx = {}
): Promise<Mutated<Task>> {
  const item = await db.query.tasks.findFirst({
    where: and(eq(tasks.id, id), eq(tasks.memexId, memexId)),
  });
  if (!item) {
    throw new NotFoundError(`Task ${id} not found`);
  }

  const setValues: Record<string, unknown> = {};
  if (updates.title !== undefined) setValues.title = updates.title;
  if (updates.description !== undefined) setValues.description = updates.description;
  if (updates.acceptanceCriteria !== undefined) setValues.acceptanceCriteria = updates.acceptanceCriteria;
  if (updates.sectionRef !== undefined) setValues.sectionRef = updates.sectionRef;

  if (Object.keys(setValues).length === 0) {
    // silent: no caller-supplied fields means no DB write; brand the return so
    // the type contract still says this went through mutate().
    return mutate(
      ctx,
      { memexId, docId: item.docId, entity: "task", action: "updated" },
      async () => item,
      { silent: true },
    );
  }

  // spec-122 dec-2/dec-5 — re-attribute on edit (who touched it last).
  Object.assign(setValues, await resolveActorColumns(ctx));

  return mutate(
    ctx,
    { memexId, docId: item.docId, entity: "task", action: "updated" },
    async () => {
      const [updated] = await db
        .update(tasks)
        .set(setValues)
        .where(and(eq(tasks.id, id), eq(tasks.memexId, memexId)))
        .returning();
      return updated;
    },
  );
}

export async function deleteTask(memexId: string, id: string): Promise<Mutated<Task>> {
  const item = await db.query.tasks.findFirst({
    where: and(eq(tasks.id, id), eq(tasks.memexId, memexId)),
  });
  if (!item) {
    throw new NotFoundError(`Task ${id} not found`);
  }

  return mutate(
    {},
    { memexId, docId: item.docId, entity: "task", action: "deleted" },
    async () => {
      await db.delete(tasks).where(and(eq(tasks.id, id), eq(tasks.memexId, memexId)));
      return item;
    },
  );
}

export async function getReadyTasks(
  memexId: string,
  docId: string
): Promise<Task[]> {
  const all = await listTasks(memexId, docId);
  return all.filter((w) => !w.blocked && w.status === "not_started");
}
