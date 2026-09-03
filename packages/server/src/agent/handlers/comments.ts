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
  addComment,
  addAnchoredComment,
  addDecisionComment,
  addTaskComment,
  listComments,
  listDecisionComments,
  listTaskComments,
  listCommentsForDoc,
  reviewDocComments,
  resolveComment,
  type CommentExtras,
  type ListCommentsOptions,
} from "../../services/comments.js";
import {
  COMMENT_TYPES,
  type CommentType,
} from "../../types/roles.js";
import {
  ValidationError,
} from "../../types/errors.js";
import {
  formatComment,
  formatCommentList,
  formatDocComments,
  formatReviewComments,
  formatDocStatusHeader,
} from "../../formatting/formatters.js";
import {
  VERBOSE_FIELD,
  isDocLikeKind,
  reqCtx,
  resolveRefArg,
  type ToolSpec,
} from "./tool-contract.js";

// ── Moved here from shared.ts by spec-546 t-2: this file is the symbol's only
// consumer, so it lives with its consumer and is private [per std-51].
const COMMENT_TYPE_DESC =
  `Comment taxonomy. Pick one of: ${COMMENT_TYPES.join(", ")}. ` +
  "Use `plan` before coding, `progress` for in-flight notes, `issue` for blockers, `deferred` for skipped work, " +
  "`question` when you need a human, `cross_reference` for observations whose action lives elsewhere (combine with exactly one of referenceBriefId / referenceStandardId / referenceDecisionId / referenceTaskId), " +
  "`readiness_check` for execution-plan READY/NOT READY assessments, `plan_revision` after re-submitting a plan, `drift` for standard drift findings.";

// Per dec-4 of doc-20: terse `list_comments` emits one line per comment with
// the canonical ref + type + status + a 50-char content snippet. Per b-36 T-2
// comments are path-addressable (`.../comments/c-N`), so the ref is the stable
// reference an agent pastes back into a follow-up call.
const COMMENT_SNIPPET_LEN = 50;

function formatTerseComment(
  c: {
    seq: number;
    commentType: string;
    resolvedAt: Date | null;
    content: string;
  },
  slugs: { namespace: string; memex: string } | null,
  doc: import("../../db/schema.js").Doc,
): string {
  const status = c.resolvedAt ? "resolved" : "open";
  const oneLine = c.content.replace(/\s+/g, " ").trim();
  const snippet =
    oneLine.length > COMMENT_SNIPPET_LEN
      ? `${oneLine.slice(0, COMMENT_SNIPPET_LEN)}…`
      : oneLine;
  const ref = slugs
    ? buildChildRef(slugs, doc, { type: "comments", seq: c.seq })
    : `c-${c.seq}`;
  return `(ref: ${ref}) [${c.commentType}, ${status}] "${snippet}"`;
}

function formatDocCommentsTerse(
  result: {
    sections: {
      section: { sectionType: string; title?: string | null; id: string };
      comments: { seq: number; commentType: string; resolvedAt: Date | null; content: string }[];
    }[];
    decisions: {
      decision: { seq: number };
      comments: { seq: number; commentType: string; resolvedAt: Date | null; content: string }[];
    }[];
    tasks: {
      task: { seq: number };
      comments: { seq: number; commentType: string; resolvedAt: Date | null; content: string }[];
    }[];
  },
  slugs: { namespace: string; memex: string } | null,
  doc: import("../../db/schema.js").Doc,
): string[] {
  const lines: string[] = [];
  for (const sg of result.sections) {
    const label = `section ${sg.section.title ?? sg.section.sectionType}`;
    for (const c of sg.comments) {
      lines.push(`- ${formatTerseComment(c, slugs, doc)} on ${label}`);
    }
  }
  for (const dg of result.decisions) {
    const label = `dec-${dg.decision.seq}`;
    for (const c of dg.comments) {
      lines.push(`- ${formatTerseComment(c, slugs, doc)} on ${label}`);
    }
  }
  for (const tg of result.tasks) {
    const label = `t-${tg.task.seq}`;
    for (const c of tg.comments) {
      lines.push(`- ${formatTerseComment(c, slugs, doc)} on ${label}`);
    }
  }
  return lines;
}


export const commentsTools: ToolSpec[] = [
  {
    name: "add_comment",
    annotations: { title: "Add comment", readOnlyHint: false, destructiveHint: false },
    description:
      "Add a comment to a section, decision, or task. `ref` is a canonical ref to the target. When called via MCP the comment is stamped `source='agent'` automatically. **Use type=`question` when you hit a knowledge gap the codebase can't answer** — surface to the user via this tool rather than producing plausible-looking code.",
    schema: {
      ref: z
        .string()
        .describe(
          "Canonical ref to the comment's target — a section, decision, or task. Examples: `mindset/main/specs/spec-3/sections/s-2`, `.../decisions/dec-1`, `.../tasks/t-4`.",
        ),
      authorName: z.string().describe("Display name for the comment author. Defaults to 'Memex agent' when called by the agent."),
      content: z.string().describe("Comment body (markdown)."),
      type: z
        .enum(COMMENT_TYPES as readonly [string, ...string[]])
        .optional()
        .describe(COMMENT_TYPE_DESC),
      referenceRef: z
        .string()
        .optional()
        .describe(
          "Cross-reference target — canonical ref to a spec, standard, decision, or task. Use only with type=cross_reference.",
        ),
      anchorOffset: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe(
          "spec-100 (geo-comments): anchor this comment to a point in a SECTION's markdown. Character offset into the section source where the `[^c-N]` marker is inserted. The snapshot of the surrounding sentence is captured automatically. Only valid when `ref` is a section.",
        ),
      verbose: VERBOSE_FIELD,
    },
    async handler(input, ctx) {
      const ref = input.ref as string;
      // spec-126 change-10: attribute the comment to the acting user when the
      // in-app agent set ctx.userName (it acts on the signed-in human's behalf).
      // MCP/unknown callers keep the historic 'Memex agent' / source='agent'.
      const actingUser = ctx.userName;
      const authorName =
        (input.authorName as string | undefined) ?? actingUser ?? "Memex agent";
      const content = input.content as string;
      const type = input.type as CommentType | undefined;
      const referenceRef = input.referenceRef as string | undefined;
      const anchorOffset = input.anchorOffset as number | undefined;

      const resolved = await resolveRefArg(ctx, ref);
      if (
        resolved.entity.kind !== "section" &&
        resolved.entity.kind !== "decision" &&
        resolved.entity.kind !== "task"
      ) {
        throw new ValidationError(
          `add_comment expects a section, decision, or task ref; got ${resolved.entity.kind}.`,
        );
      }
      const { memexId, doc, slugs } = resolved;

      const extras: CommentExtras = {
        // human when the in-app agent acts for a signed-in user (change-10);
        // agent otherwise (MCP / no bound human) — preserves the v0 semantics.
        source: actingUser ? "human" : "agent",
        ...(type !== undefined ? { type } : {}),
      };
      if (referenceRef !== undefined) {
        const xref = await resolveRefArg(ctx, referenceRef, "referenceRef");
        switch (xref.entity.kind) {
          case "spec":
            // referenceBriefId column predates the Spec → Spec rename and is
            // kept stable to avoid a schema/data migration; the value is a
            // Spec doc id.
            extras.referenceBriefId = xref.entity.row.id;
            break;
          case "standard":
            extras.referenceStandardId = xref.entity.row.id;
            break;
          case "decision":
            extras.referenceDecisionId = xref.entity.row.id;
            break;
          case "task":
            extras.referenceTaskId = xref.entity.row.id;
            break;
          default:
            throw new ValidationError(
              `referenceRef must resolve to a spec, standard, decision, or task; got ${xref.entity.kind}.`,
            );
        }
      }

      // spec-100: anchoring only applies to section targets. Reject the
      // combination early rather than silently dropping the offset.
      if (anchorOffset !== undefined && resolved.entity.kind !== "section") {
        throw new ValidationError(
          `anchorOffset is only valid when commenting on a section; got ${resolved.entity.kind}.`,
        );
      }

      let comment;
      if (resolved.entity.kind === "section") {
        comment =
          anchorOffset !== undefined
            ? await addAnchoredComment(
                memexId,
                resolved.entity.row.id,
                authorName,
                content,
                anchorOffset,
                extras,
              )
            : await addComment(memexId, resolved.entity.row.id, authorName, content, extras);
      } else if (resolved.entity.kind === "decision") {
        comment = await addDecisionComment(
          memexId,
          resolved.entity.row.id,
          authorName,
          content,
          extras,
        );
      } else {
        comment = await addTaskComment(memexId, resolved.entity.row.id, authorName, content, extras);
      }

      if (ctx.verbose) {
        return `${formatDocStatusHeader(doc)}\n\n${formatComment(comment)}`;
      }
      const commentRef = buildChildRef(slugs, doc, { type: "comments", seq: comment.seq });
      return `Comment added (ref: ${commentRef}).`;
    },
  },
  {
    name: "list_comments",
    annotations: { title: "List comments", readOnlyHint: true, destructiveHint: false },
    description:
      "List comments. Replaces list_doc_comments / list_task_notes / list_open_questions / review_doc_comments via filter combinations:\n" +
      "  - **By target**: pass a section/decision/task ref.\n" +
      "  - **By document**: pass a doc-level ref — returns every comment across sections/decisions/tasks of the doc.\n" +
      "  - **types**: array of comment types to filter (e.g. ['question'], ['drift', 'plan_revision']).\n" +
      "  - **mode='review'**: review-shaped output (excludes agent `progress` notes by default; pass explicit `types` to override). Only valid with a doc-level ref.\n" +
      "  - **mode='task_notes'**: agent-typed notes on a task (plan/progress/issue/deferred/question). Only valid with a task ref.",
    schema: {
      ref: z
        .string()
        .describe(
          "Canonical ref to the document, section, decision, or task to filter comments by.",
        ),
      types: z
        .array(z.enum(COMMENT_TYPES as readonly [string, ...string[]]))
        .optional()
        .describe("Comment-type filter, e.g. ['question'] or ['drift', 'plan_revision']."),
      mode: z.enum(["default", "review", "task_notes"]).optional().describe("'review' is doc-scoped review output (excludes agent `progress` notes); 'task_notes' is task-scoped agent notes (plan/progress/issue/deferred/question)."),
      verbose: VERBOSE_FIELD,
    },
    async handler(input, ctx) {
      const ref = input.ref as string;
      const types = input.types as CommentType[] | undefined;
      const mode = input.mode as string | undefined;

      const resolved = await resolveRefArg(ctx, ref);
      const { memexId, doc, slugs } = resolved;

      // Doc-scoped paths
      if (isDocLikeKind(resolved.entity.kind)) {
        if (mode === "review") {
          const allowed: CommentType[] =
            types && types.length > 0
              ? types
              : COMMENT_TYPES.filter((t) => t !== "progress");
          const result = await reviewDocComments(memexId, doc.id, { typeFilter: allowed });
          if (ctx.verbose) {
            return `${formatDocStatusHeader(doc)}\n\n${formatReviewComments(result)}`;
          }
          const lines = formatDocCommentsTerse(result, slugs, doc);
          if (lines.length === 0) return "No open comments to review on this doc.";
          return lines.join("\n");
        }

        const opts: ListCommentsOptions = {};
        if (types && types.length > 0) opts.typeFilter = types;
        const result = await listCommentsForDoc(memexId, doc.id, opts);
        if (ctx.verbose) {
          return `${formatDocStatusHeader(doc)}\n\n${formatDocComments(result)}`;
        }
        const lines = formatDocCommentsTerse(result, slugs, doc);
        if (lines.length === 0) return "No comments on this doc.";
        return lines.join("\n");
      }

      // Single-target paths.
      if (
        resolved.entity.kind !== "section" &&
        resolved.entity.kind !== "decision" &&
        resolved.entity.kind !== "task"
      ) {
        throw new ValidationError(
          `list_comments expects a doc, section, decision, or task ref; got ${resolved.entity.kind}.`,
        );
      }

      const opts: ListCommentsOptions = {};
      if (mode === "task_notes") {
        if (resolved.entity.kind !== "task") {
          throw new ValidationError("mode='task_notes' requires a task ref.");
        }
        opts.typeFilter = ["plan", "progress", "issue", "deferred", "question"] as CommentType[];
      } else if (types && types.length > 0) {
        opts.typeFilter = types;
      }

      let comments;
      if (resolved.entity.kind === "section") {
        comments = await listComments(memexId, resolved.entity.row.id, opts);
      } else if (resolved.entity.kind === "decision") {
        comments = await listDecisionComments(memexId, resolved.entity.row.id, opts);
      } else {
        comments = await listTaskComments(memexId, resolved.entity.row.id, opts);
      }

      if (ctx.verbose) {
        return `${formatDocStatusHeader(doc)}\n\n${formatCommentList(comments, slugs, doc)}`;
      }
      if (comments.length === 0) return "No comments on this target.";
      return comments
        .map((c) => `- ${formatTerseComment(c, slugs, doc)}`)
        .join("\n");
    },
  },
  {
    name: "update_comment",
    annotations: { title: "Update comment", readOnlyHint: false, destructiveHint: false },
    description:
      "Update a comment. Today: status='resolved' resolves the comment after addressing it (replaces resolve_comment). Include a resolution describing what was done.",
    schema: {
      ref: z
        .string()
        .describe(
          "Canonical ref to the comment, e.g. `mindset/main/specs/spec-3/comments/c-5`.",
        ),
      status: z.literal("resolved").describe("Currently only 'resolved' is supported."),
      resolution: z.string().optional().describe("Optional note describing what was done to resolve the comment."),
      verbose: VERBOSE_FIELD,
    },
    async handler(input, ctx) {
      const ref = input.ref as string;
      const resolution = input.resolution as string | undefined;

      const resolved = await resolveRefArg(ctx, ref);
      if (resolved.entity.kind !== "comment") {
        throw new ValidationError(
          `update_comment expects a comment ref; got ${resolved.entity.kind}.`,
        );
      }
      const { memexId, doc, slugs, entity } = resolved;
      const comment = await resolveComment(memexId, entity.row.id, resolution, reqCtx(ctx));
      if (ctx.verbose) {
        return `${formatDocStatusHeader(doc)}\n\nComment resolved.\n${formatComment(comment)}`;
      }
      const commentRef = buildChildRef(slugs, doc, { type: "comments", seq: comment.seq });
      return `Comment resolved (ref: ${commentRef}).`;
    },
  },

  // ── Spec lifecycle ─────────────────────────────────────
];
