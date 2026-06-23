// spec-366 (sol-1): per-domain tool handlers extracted from agent/tool-specs.ts.
// Each module owns one domain's ToolSpec entries (schema + handler);
// agent/tool-specs.ts composes them into the single `toolSpecs` catalogue.
// Infra (ToolCtx, helpers, guidance envelope) lives in ./shared.js (std-12).

import {
  z,
} from "zod";
import {
  buildChildRef,
} from "../../mcp/refs.js";
import {
  createTask,
  listTasks,
  getTask,
  updateTaskStatus,
  updateTask,
  deleteTask,
  getReadyTasks,
} from "../../services/tasks.js";
import {
  addBlocker,
  removeBlocker,
} from "../../services/shared/blockers.js";
import {
  ValidationError,
} from "../../types/errors.js";
import {
  formatReadyTasks,
  formatDocStatusHeader,
} from "../../formatting/formatters.js";
import {
  TASK_STATUS,
  VERBOSE_FIELD,
  findNewlyUnblockedDependents,
  formatState,
  formatTaskReadyMarker,
  fullDocState,
  isDocLikeKind,
  reqCtx,
  resolveRefArg,
  type ToolSpec,
} from "./shared.js";

export const tasksTools: ToolSpec[] = [
  {
    name: "list_tasks",
    annotations: { title: "List tasks", readOnlyHint: true, destructiveHint: false },
    description:
      "List tasks on a document, with optional filters. " +
      "`readyOnly: true` returns only unblocked, not_started tasks (replaces get_ready_tasks) — the response includes a pre-task reminder. " +
      "Without filters, behaves like the task subset of get_doc.",
    schema: {
      ref: z
        .string()
        .describe(
          "Canonical ref to the parent document, e.g. `mindset/main/specs/spec-3`.",
        ),
      readyOnly: z
        .boolean()
        .optional()
        .describe("Only return tasks with status='not_started' and no open blockers."),
      verbose: VERBOSE_FIELD,
    },
    async handler(input, ctx) {
      const ref = input.ref as string;
      const readyOnly = input.readyOnly as boolean | undefined;

      const resolved = await resolveRefArg(ctx, ref);
      if (!isDocLikeKind(resolved.entity.kind)) {
        throw new ValidationError(
          `list_tasks expects a doc-level ref; got ${resolved.entity.kind}.`,
        );
      }
      const { memexId, doc, slugs } = resolved;

      if (ctx.verbose) {
        if (readyOnly) {
          const ready = await getReadyTasks(memexId, doc.id);
          return `${formatDocStatusHeader(doc)}\n\n${formatReadyTasks(ready, doc.handle)}`;
        }
        const all = await listTasks(memexId, doc.id);
        if (all.length === 0) {
          return `${formatDocStatusHeader(doc)}\n\nNo tasks on this doc.`;
        }
        const lines = all.map((t) => `- t-${t.seq} [${t.status}] "${t.title}"`);
        return `${formatDocStatusHeader(doc)}\n\n${lines.join("\n")}`;
      }

      // Terse path. Per dec-4: include the canonical task ref + READY|BLOCKED
      // marker so a follow-up `update_task` call has everything it needs
      // without another round-trip.
      if (readyOnly) {
        const ready = await getReadyTasks(memexId, doc.id);
        if (ready.length === 0) return "No ready tasks.";
        return ready
          .map((t) => {
            const taskRef = buildChildRef(slugs, doc, { type: "tasks", seq: t.seq });
            return `- ref: ${taskRef} [not_started, READY] "${t.title}"`;
          })
          .join("\n");
      }
      const all = await listTasks(memexId, doc.id);
      if (all.length === 0) return "No tasks on this doc.";
      return all
        .map((t) => {
          const blockerHandles = [
            ...t.blockedByDecisions.map((d) => `dec-${d.seq}`),
            ...t.blockedByTasks.map((bt) => `t-${bt.seq}`),
          ];
          const marker =
            blockerHandles.length > 0
              ? `BLOCKED-by-${blockerHandles.join(",")}`
              : "READY";
          const taskRef = buildChildRef(slugs, doc, { type: "tasks", seq: t.seq });
          return `- ref: ${taskRef} [${t.status}, ${marker}] "${t.title}"`;
        })
        .join("\n");
    },
  },
  {
    name: "create_task",
    annotations: { title: "Create task", readOnlyHint: false, destructiveHint: false },
    description:
      "Create a task. Build-phase only — see the two non-negotiable rules in the MCP instructions (tasks only in 'build', resolve open decisions first; a 'decide/choose/figure out/pick' title is a decision-in-disguise → use create_decision instead). Include acceptance criteria.",
    schema: {
      ref: z
        .string()
        .describe(
          "Canonical ref to the parent document, e.g. `mindset/main/specs/spec-3`.",
        ),
      title: z.string().describe("Concrete unit of work — outcome, not a research/decide verb."),
      description: z.string().describe("What the task delivers and any constraints the implementer needs."),
      acceptanceCriteria: z
        .array(z.object({ description: z.string(), done: z.boolean().default(false) }))
        .optional()
        .describe("Checklist items that gate completion. Each {description, done?:false}."),
      sectionRef: z.string().optional().describe("Section type this task delivers against."),
      verbose: VERBOSE_FIELD,
    },
    async handler(input, ctx) {
      const ref = input.ref as string;
      const title = input.title as string;
      const description = input.description as string;
      const acceptanceCriteria = input.acceptanceCriteria as
        | Array<{ description: string; done: boolean }>
        | undefined;
      const sectionRef = input.sectionRef as string | undefined;

      const resolved = await resolveRefArg(ctx, ref);
      if (!isDocLikeKind(resolved.entity.kind)) {
        throw new ValidationError(
          `create_task expects a doc-level ref; got ${resolved.entity.kind}.`,
        );
      }
      const { memexId, doc, slugs } = resolved;
      const task = await createTask(
        memexId,
        doc.id,
        title,
        description,
        acceptanceCriteria,
        sectionRef,
        reqCtx(ctx),
      );
      if (ctx.verbose) {
        const state = await fullDocState(memexId, doc.id);
        const url = await ctx.workspaceUrl(memexId);
        return await formatState(url, state, ctx);
      }
      const taskRef = buildChildRef(slugs, doc, { type: "tasks", seq: task.seq });
      return `Task created: ref: ${taskRef} "${task.title}"`;
    },
  },
  {
    name: "update_task",
    annotations: { title: "Update task", readOnlyHint: false, destructiveHint: false },
    description:
      "Update a task. Pass only the fields you want to change. Replaces update_task_status, add_blocker, remove_blocker.\n" +
      "  - **status**: 'not_started' | 'in_progress' | 'complete'. Completing may unblock dependents.\n" +
      "  - **addBlockerRef**: canonical ref to a decision or task in the same parent doc.\n" +
      "  - **removeBlockerRef**: canonical ref to a decision or task in the same parent doc.\n" +
      "  - **title / description / acceptanceCriteria / sectionRef**: in-place edits.\n" +
      "Multiple fields can be set in one call (e.g. status + acceptanceCriteria for verification).\n" +
      "When transitioning to `status: 'in_progress'` on a Spec in build, MUST call `get_information(topic='ac-emission')` first if you haven't already this session — that's the moment you're about to write code + tests, and the AC tagging mechanic is non-obvious.",
    schema: {
      ref: z
        .string()
        .describe(
          "Canonical ref to the task, e.g. `mindset/main/specs/spec-3/tasks/t-2`.",
        ),
      status: z.enum(TASK_STATUS).optional().describe("'not_started' | 'in_progress' | 'complete'. Completing may unblock dependents."),
      title: z.string().optional().describe("Replace the task title."),
      description: z.string().optional().describe("Replace the task description."),
      acceptanceCriteria: z
        .array(z.object({ description: z.string(), done: z.boolean().default(false) }))
        .optional()
        .describe("Replace the acceptance-criteria checklist (each item: {description, done?:false})."),
      sectionRef: z.string().nullable().optional().describe("Section type this task delivers against. Pass null to clear."),
      addBlockerRef: z
        .string()
        .optional()
        .describe(
          "Canonical ref to a decision or task in the same parent doc, e.g. `mindset/main/specs/spec-3/decisions/dec-2`.",
        ),
      removeBlockerRef: z
        .string()
        .optional()
        .describe(
          "Canonical ref to a decision or task in the same parent doc, e.g. `mindset/main/specs/spec-3/decisions/dec-2`.",
        ),
      verbose: VERBOSE_FIELD,
    },
    async handler(input, ctx) {
      const ref = input.ref as string;
      const status = input.status as string | undefined;
      const title = input.title as string | undefined;
      const description = input.description as string | undefined;
      const acceptanceCriteria = input.acceptanceCriteria as
        | Array<{ description: string; done: boolean }>
        | undefined;
      const sectionRef = input.sectionRef as string | null | undefined;
      const addBRef = input.addBlockerRef as string | undefined;
      const rmBRef = input.removeBlockerRef as string | undefined;

      const resolved = await resolveRefArg(ctx, ref);
      if (resolved.entity.kind !== "task") {
        throw new ValidationError(
          `update_task expects a task ref; got ${resolved.entity.kind}.`,
        );
      }
      const { memexId, doc, slugs, entity } = resolved;
      const taskUuid = entity.row.id;

      // Resolve a blocker ref → service-layer handle string. The blocker must
      // live in the same parent doc as the task; the service rejects cross-doc
      // blockers via its `getDecision/getTask(docId)` lookup, but we double-
      // check here so the error surfaces at the boundary.
      const resolveBlockerRef = async (
        blockerRef: string,
        argName: string,
      ): Promise<string> => {
        const br = await resolveRefArg(ctx, blockerRef, argName);
        if (br.doc.id !== doc.id) {
          throw new ValidationError(
            `${argName} must point to an entity in the same parent doc.`,
          );
        }
        if (br.entity.kind === "decision") {
          return `D-${br.entity.row.seq}`;
        }
        if (br.entity.kind === "task") {
          return `T-${br.entity.row.seq}`;
        }
        throw new ValidationError(
          `${argName} must resolve to a decision or task; got ${br.entity.kind}.`,
        );
      };

      const messages: string[] = [];
      if (
        title !== undefined ||
        description !== undefined ||
        acceptanceCriteria !== undefined ||
        sectionRef !== undefined
      ) {
        const updated = await updateTask(memexId, taskUuid, {
          title,
          description,
          acceptanceCriteria,
          sectionRef,
        }, reqCtx(ctx));
        const taskRef = buildChildRef(slugs, doc, { type: "tasks", seq: updated.seq });
        messages.push(`Task ref: ${taskRef} fields updated.`);
      }
      if (status !== undefined) {
        const updated = await updateTaskStatus(memexId, taskUuid, status, reqCtx(ctx));
        let unblockedHint = "";
        // Per dec-1: when completing a task unblocks dependents, name them so
        // the agent skips the follow-up `list_tasks(readyOnly:true)` call. This
        // is RESULT-REPORTING (a fact about what the call did), so it stays in
        // the handler. The "leave a progress comment" STEER is guidance, owned by
        // composeGuidanceEnvelope — we signal the event, not the words.
        if (status === "complete") {
          const unblocked = await findNewlyUnblockedDependents(memexId, taskUuid);
          if (unblocked.length > 0) {
            unblockedHint = ` Unblocked dependents: ${unblocked
              .map((u) => `t-${u.seq}`)
              .join(", ")}.`;
          }
          if (ctx.footerSlot) {
            // spec-219 comb-through: park the build-completion picture so the
            // footer can push toward verify the moment the last task is done
            // (the build->verify analogue of create_ac's build-push).
            const open = (await listTasks(memexId, doc.id)).filter(
              (t) => t.status !== "complete",
            ).length;
            ctx.footerSlot.signal = {
              kind: "task_completed",
              allComplete: open === 0,
              remaining: open,
            };
          }
        }
        const taskRef = buildChildRef(slugs, doc, { type: "tasks", seq: updated.seq });
        messages.push(
          `Task ref: ${taskRef} status → "${updated.status}".${unblockedHint}`,
        );
      }
      if (addBRef !== undefined) {
        const handle = await resolveBlockerRef(addBRef, "addBlockerRef");
        await addBlocker(memexId, taskUuid, handle);
        const fresh = await getTask(memexId, taskUuid);
        const taskRef = buildChildRef(slugs, doc, { type: "tasks", seq: fresh.seq });
        messages.push(
          `Blocker ${handle} added to ref: ${taskRef} ${formatTaskReadyMarker(fresh)}.`,
        );
      }
      if (rmBRef !== undefined) {
        const handle = await resolveBlockerRef(rmBRef, "removeBlockerRef");
        await removeBlocker(memexId, taskUuid, handle);
        const fresh = await getTask(memexId, taskUuid);
        const taskRef = buildChildRef(slugs, doc, { type: "tasks", seq: fresh.seq });
        messages.push(
          `Blocker ${handle} removed from ref: ${taskRef} ${formatTaskReadyMarker(fresh)}.`,
        );
      }

      if (ctx.verbose) {
        const fresh = await getTask(memexId, taskUuid);
        const state = await fullDocState(memexId, fresh.docId);
        const url = await ctx.workspaceUrl(memexId);
        // spec-219 Phase 2 (sole-author): the completion steer is already
        // signalled above (kind:'task_completed'); composeGuidanceEnvelope owns
        // the prose for terse AND verbose. Nothing to park here.
        return await formatState(url, state, ctx);
      }

      if (messages.length === 0) {
        return "No-op: pass at least one of status, title, description, acceptanceCriteria, sectionRef, addBlockerRef, removeBlockerRef.";
      }
      return messages.join(" ");
    },
  },
  {
    name: "delete_task",
    annotations: { title: "Delete task", readOnlyHint: false, destructiveHint: true },
    description: "Delete a task. Also removes its blockers and dependencies.",
    schema: {
      ref: z
        .string()
        .describe(
          "Canonical ref to the task, e.g. `mindset/main/specs/spec-3/tasks/t-2`.",
        ),
      verbose: VERBOSE_FIELD,
    },
    async handler(input, ctx) {
      const ref = input.ref as string;
      const resolved = await resolveRefArg(ctx, ref);
      if (resolved.entity.kind !== "task") {
        throw new ValidationError(
          `delete_task expects a task ref; got ${resolved.entity.kind}.`,
        );
      }
      const { memexId, doc, slugs, entity } = resolved;
      const deleted = await deleteTask(memexId, entity.row.id);
      if (ctx.verbose) {
        const state = await fullDocState(memexId, deleted.docId);
        const url = await ctx.workspaceUrl(memexId);
        return await formatState(url, state, ctx);
      }
      const taskRef = buildChildRef(slugs, doc, { type: "tasks", seq: deleted.seq });
      return `Task ref: ${taskRef} "${deleted.title}" deleted.`;
    },
  },

  // ── Comment CRUD ─────────────────────────────────────────
];
