import { and, eq, inArray, isNotNull, desc } from "drizzle-orm";
import { db } from "../db/connection.js";
import { documents, docSections, docComments, tasks } from "../db/schema.js";
import type { Doc, DocSection } from "../db/schema.js";
import { NotFoundError, ValidationError } from "../types/errors.js";
import { mutate, type Mutated } from "./mutate.js";
import { nextDocHandle } from "./documents.js";
import { withSeqRetry } from "./shared/sequence.js";

// Standardised section types for execution plans, per dec-13. Order is the order they get
// inserted (and thus the order they render). `readiness_assessment` is intentionally NOT
// in this list — per dec-26 it's appended later by the agent's submit flow, not at plan
// creation, so we don't pre-create an empty one.
export const EXECUTION_PLAN_SECTION_TYPES = [
  "files_modified",
  "dependency_flow",
  "conflicts",
  "narrative",
] as const;

export type ExecutionPlanSectionType = (typeof EXECUTION_PLAN_SECTION_TYPES)[number];

const SECTION_TITLES: Record<ExecutionPlanSectionType, string> = {
  files_modified: "Files modified",
  dependency_flow: "Dependency flow",
  conflicts: "Conflicts",
  narrative: "Narrative",
};

export type ExecutionPlanSection = DocSection;

export interface ExecutionPlan extends Doc {
  sections: ExecutionPlanSection[];
}

export interface CreateExecutionPlanInput {
  /** Override the auto-generated title ("Execution plan for <task title>"). */
  title?: string;
  /**
   * Optional starting content per section type. Any types not provided default to empty
   * markdown — the four standardised sections always exist on a freshly created plan so
   * the agent / UI can target them by sectionType without a separate "add section" step.
   */
  sections?: Partial<Record<ExecutionPlanSectionType, string>>;
}

async function getOwnedTask(memexId: string, taskId: string) {
  const item = await db.query.tasks.findFirst({
    where: and(eq(tasks.id, taskId), eq(tasks.memexId, memexId)),
  });
  if (!item) {
    throw new NotFoundError(`Task ${taskId} not found`);
  }
  return item;
}

/**
 * Create an execution plan document linked to a task.
 *
 * Per dec-6: the plan is itself a `documents` row with `docType='execution_plan'`,
 * referenced from `tasks.execution_plan_doc_id`. Per dec-13, the plan ships with
 * four standardised sections (files_modified, dependency_flow, conflicts, narrative).
 *
 * Throws ValidationError if the task already has a linked plan — per dec-12 there
 * are no plan revisions, so the caller is expected to clear the existing link or update
 * sections in place rather than creating a parallel document.
 */
export async function createExecutionPlan(
  memexId: string,
  taskId: string,
  input: CreateExecutionPlanInput = {},
  createdByUserId?: string,
): Promise<Mutated<ExecutionPlan>> {
  const item = await getOwnedTask(memexId, taskId);
  if (item.executionPlanDocId) {
    throw new ValidationError(
      `Task ${taskId} already has an execution plan (${item.executionPlanDocId}). Update sections in place rather than creating a new plan (dec-12).`,
    );
  }

  const title =
    input.title?.trim() && input.title.trim().length > 0
      ? input.title.trim()
      : `Execution plan for ${item.title}`;

  // Two independent invariants per dec-2: the plan document was created, and the
  // task now points at it. One mutate() wraps the transaction; both events emit
  // post-commit. Plan-doc key uses a factory because the new doc's id isn't known
  // until the insert returns.
  return mutate(
    {},
    [
      (created) => ({ memexId, docId: created.id, entity: "document", action: "created" }),
      { memexId, docId: item.docId, entity: "task", action: "updated" },
    ],
    async () => {
      // spec-187: the doc-N handle mint is the racy MAX+1 read — a concurrent
      // doc/plan create in the same memex can collide on
      // `documents_memex_id_handle_unique`. Pure-DB tx → retry it wholesale.
      const result = await withSeqRetry(() => db.transaction(async (tx) => {
        const handle = await nextDocHandle(memexId, tx);
        const [doc] = await tx
          .insert(documents)
          .values({
            memexId,
            handle,
            title,
            docType: "execution_plan",
            status: "draft",
            createdByUserId: createdByUserId ?? null,
          })
          .returning();

        const sectionRows = EXECUTION_PLAN_SECTION_TYPES.map((sectionType, idx) => ({
          docId: doc.id,
          sectionType,
          title: SECTION_TITLES[sectionType],
          content: input.sections?.[sectionType] ?? "",
          seq: idx + 1,
          position: idx + 1, // spec-150: display position == identity seq at creation
        }));
        const sections = await tx.insert(docSections).values(sectionRows).returning();

        await tx
          .update(tasks)
          .set({ executionPlanDocId: doc.id })
          .where(and(eq(tasks.id, taskId), eq(tasks.memexId, memexId)));

        return { doc, sections };
      }), "documents_memex_id_handle_unique");

      return { ...result.doc, sections: result.sections };
    },
  );
}

/**
 * Fetch the execution plan linked to a task, or null if no plan is linked.
 * Returns the plan document with its sections ordered by seq.
 */
export async function getExecutionPlanForTask(
  memexId: string,
  taskId: string,
): Promise<ExecutionPlan | null> {
  const item = await getOwnedTask(memexId, taskId);
  if (!item.executionPlanDocId) return null;

  const doc = await db.query.documents.findFirst({
    where: and(
      eq(documents.id, item.executionPlanDocId),
      eq(documents.memexId, memexId),
    ),
  });
  if (!doc) {
    // FK pointed at a doc this account can't see — treat as missing rather than leaking.
    return null;
  }

  const sections = await db
    .select()
    .from(docSections)
    .where(eq(docSections.docId, doc.id))
    .orderBy(docSections.seq);

  return { ...doc, sections };
}

/**
 * List the execution plans dependent on a Spec: every plan that is the
 * `executionPlanDocId` of a task in that Spec doc. Useful for the Spec
 * detail view and for standard drift propagation (t-13).
 */
export async function listDependentExecutionPlans(
  memexId: string,
  briefId: string,
): Promise<ExecutionPlan[]> {
  const spec = await db.query.documents.findFirst({
    where: and(eq(documents.id, briefId), eq(documents.memexId, memexId)),
  });
  if (!spec) {
    throw new NotFoundError(`Document ${briefId} not found`);
  }

  const items = await db
    .select({ executionPlanDocId: tasks.executionPlanDocId })
    .from(tasks)
    .where(
      and(
        eq(tasks.docId, briefId),
        eq(tasks.memexId, memexId),
        isNotNull(tasks.executionPlanDocId),
      ),
    );

  const planDocIds = items
    .map((row) => row.executionPlanDocId)
    .filter((id): id is string => Boolean(id));

  if (planDocIds.length === 0) return [];

  const planDocs = await db
    .select()
    .from(documents)
    .where(
      and(
        inArray(documents.id, planDocIds),
        eq(documents.memexId, memexId),
      ),
    );

  const allSections = await db
    .select()
    .from(docSections)
    .where(inArray(docSections.docId, planDocIds))
    .orderBy(docSections.seq);

  const sectionsByDoc = new Map<string, DocSection[]>();
  for (const s of allSections) {
    const list = sectionsByDoc.get(s.docId) ?? [];
    list.push(s);
    sectionsByDoc.set(s.docId, list);
  }

  return planDocs.map((doc) => ({
    ...doc,
    sections: sectionsByDoc.get(doc.id) ?? [],
  }));
}

/**
 * Clear the execution_plan_doc_id link on a task without deleting the plan document.
 * Pairs with createExecutionPlan to support the "relink to a fresh plan" flow that the
 * agent submit/re-submit cycle relies on.
 */
export async function clearExecutionPlanLink(
  memexId: string,
  taskId: string,
): Promise<Mutated<void>> {
  const item = await getOwnedTask(memexId, taskId);
  if (!item.executionPlanDocId) {
    // No-op when the task has no linked plan — silent: true keeps the
    // type-brand consistent without firing a spurious event.
    return mutate(
      {},
      { memexId, docId: item.docId, entity: "task", action: "updated" },
      async () => undefined,
      { silent: true },
    );
  }

  return mutate(
    {},
    { memexId, docId: item.docId, entity: "task", action: "updated" },
    async () => {
      await db
        .update(tasks)
        .set({ executionPlanDocId: null })
        .where(and(eq(tasks.id, taskId), eq(tasks.memexId, memexId)));
    },
  );
}

// ── Batched plan-readiness lookup (t-19 W2) ──────────────────────
// Single round-trip alternative to N per-task fetches of (plan doc + latest
// readiness_check comment). Mirrors the shape ExecutionPlanModal derives via
// derivePlanBadgeState — callers reuse the same pure helper to map this into a badge
// state. Account-scoped: any task id that doesn't belong to the calling account is
// silently dropped from the result set rather than 404-ing the whole batch.

export interface PlanReadinessEntry {
  taskId: string;
  /** Null when the task has no linked execution plan. */
  executionPlanDocId: string | null;
  /** Plan document `status` (e.g. 'draft', 'review', 'done'). Null when no plan linked. */
  planStatus: string | null;
  /** Most-recent `readiness_check` comment body on the task, or null. */
  readinessContent: string | null;
}

export async function getPlanReadinessBatch(
  memexId: string,
  taskIds: string[],
): Promise<PlanReadinessEntry[]> {
  if (!Array.isArray(taskIds)) {
    throw new ValidationError("taskIds must be an array");
  }
  if (taskIds.length === 0) return [];

  // Fetch only the tasks that actually belong to this account. Cross-tenant ids are
  // silently dropped — the caller's `taskIds` list is hint, not authoritative.
  const items = await db
    .select({
      id: tasks.id,
      executionPlanDocId: tasks.executionPlanDocId,
    })
    .from(tasks)
    .where(
      and(
        eq(tasks.memexId, memexId),
        inArray(tasks.id, taskIds),
      ),
    );

  if (items.length === 0) return [];

  // Plan status lookup for the linked plan docs. Plans with no execution plan get null.
  const planDocIds = items
    .map((i) => i.executionPlanDocId)
    .filter((id): id is string => Boolean(id));
  const planStatusByDoc = new Map<string, string>();
  if (planDocIds.length > 0) {
    const planRows = await db
      .select({ id: documents.id, status: documents.status })
      .from(documents)
      .where(
        and(
          inArray(documents.id, planDocIds),
          eq(documents.memexId, memexId),
        ),
      );
    for (const r of planRows) planStatusByDoc.set(r.id, r.status);
  }

  // Latest `readiness_check` comment per task. We pull all matching comments in one
  // query (account-scoped) and pick the latest by createdAt — Postgres can't do
  // DISTINCT ON cleanly via Drizzle without a raw SQL, but the comment count per work
  // item is bounded and the join is on indexed columns.
  const readinessRows = await db
    .select({
      taskId: docComments.taskId,
      content: docComments.content,
      createdAt: docComments.createdAt,
    })
    .from(docComments)
    .where(
      and(
        eq(docComments.memexId, memexId),
        eq(docComments.commentType, "readiness_check"),
        inArray(
          docComments.taskId,
          items.map((i) => i.id),
        ),
      ),
    )
    .orderBy(desc(docComments.createdAt));

  const latestReadinessByItem = new Map<string, string>();
  for (const r of readinessRows) {
    if (!r.taskId) continue;
    if (!latestReadinessByItem.has(r.taskId)) {
      latestReadinessByItem.set(r.taskId, r.content);
    }
  }

  return items.map((i) => ({
    taskId: i.id,
    executionPlanDocId: i.executionPlanDocId,
    planStatus: i.executionPlanDocId
      ? planStatusByDoc.get(i.executionPlanDocId) ?? null
      : null,
    readinessContent: latestReadinessByItem.get(i.id) ?? null,
  }));
}
