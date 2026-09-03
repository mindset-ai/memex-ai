// spec-366 (sol-1): per-domain tool handlers extracted from agent/tool-specs.ts.
// Each module owns one domain's ToolSpec entries (schema + handler);
// agent/tool-specs.ts composes them into the single `toolSpecs` catalogue.
// Infra (ToolCtx, helpers, guidance envelope) lives in ./shared.js (std-12).

import {
  z,
} from "zod";
import {
  buildChildRef,
  buildDocRef,
  memexSlugsById,
} from "../../mcp/refs.js";
import {
  createDocDraft,
} from "../../services/documents.js";
import {
  createIssue,
  listIssuesForSpec,
  getIssue as getIssueById,
  updateIssue,
  updateIssueStatus,
  convertIssueToTask,
  kickTaskToIssue,
  ISSUE_TYPES,
  isIssueType,
  type IssueType,
  type IssueStatus,
} from "../../services/issues.js";
import {
  ValidationError,
} from "../../types/errors.js";
import {
  searchMemex,
  formatSearchResults,
} from "../../services/memex-search.js";
import {
  resolveEmbeddingProvider,
} from "../../services/embedding-provider.js";
import {
  suggestActiveSpecsForIssue,
} from "./related-issues.js";
import {
  MEMEX_DESC,
  VERBOSE_FIELD,
  reqCtx,
  resolveRefArg,
  type ToolSpec,
} from "./tool-contract.js";

export const issuesTools: ToolSpec[] = [
  {
    name: "register_issue",
    annotations: { title: "Register issue", readOnlyHint: false, destructiveHint: false },
    description:
      "Register an Issue (a bug or a todo) against a Spec. Pass `spec_ref` to home it on a " +
      "specific Spec; the Issue belongs to that Spec as a whole (it does NOT anchor to a " +
      "section/decision/task). An Issue may be raised against a Spec in ANY status — draft, " +
      "specify, build, verify, done, paused, archived (no phase guard). " +
      "**Every Issue must be bound to a Spec — a homeless Issue is never persisted (std-5, no " +
      "silent default home).** If you OMIT `spec_ref`, this tool persists NOTHING and instead " +
      "returns a two-option assist so the caller can decide where it lives: (1) turn the issue " +
      "into its OWN new root Spec (pass `promote_to_spec: true` on a follow-up call), or (2) link " +
      "it to the best-suited active Spec — a ranked list of active (not done, not archived) Specs " +
      "found by semantic search over the issue text is included in the assist. Pick one and call " +
      "again with `spec_ref` set (option 2) or `promote_to_spec: true` (option 1).",
    schema: {
      memex: z.string().optional().describe(
        MEMEX_DESC + " (not needed if `spec_ref` is provided — the Memex is inferred from the Spec).",
      ),
      spec_ref: z.string().optional().describe(
        "Canonical ref to the parent Spec, e.g. `mindset/main/specs/spec-3`. OMIT to receive the " +
        "homeless-issue assist (no Issue is persisted) instead of creating one.",
      ),
      title: z.string().describe("One-line summary of the bug/todo."),
      body: z.string().describe(
        "The detail: for a bug, the symptom + reproduction/context; for a todo, the work to be done. " +
        "Carry enough structure that the Issue can be pulled into a Task without re-discovery.",
      ),
      type: z.enum(["bug", "todo"]).describe(
        "`bug` (closes the bug→failing-AC→green-AC→resolved loop) or `todo` (forward-looking human-level backlog).",
      ),
      severity: z.string().optional().describe(
        "Free-text severity (e.g. low / medium / high / critical). Optional.",
      ),
      promote_to_spec: z.boolean().optional().describe(
        "Homeless-issue option (1): with NO `spec_ref`, create a new root Spec (parent_doc_id NULL) " +
        "seeded from the issue title/body and persist NO Issue row (the issue becomes the Spec). " +
        "Ignored when `spec_ref` is set.",
      ),
      verbose: VERBOSE_FIELD,
    },
    async handler(input, ctx) {
      const specRef = input.spec_ref as string | undefined;
      const title = input.title as string;
      const body = input.body as string;
      const type = input.type as IssueType;
      const severity = (input.severity as string | undefined) ?? null;
      const promoteToSpecOpt = input.promote_to_spec === true;

      if (!isIssueType(type)) {
        throw new ValidationError(
          `register_issue: invalid type '${type}'. Must be one of: ${ISSUE_TYPES.join(", ")}.`,
        );
      }

      // ── Homed path: a Spec ref was supplied — create the Issue under it. ──
      if (specRef) {
        const resolved = await resolveRefArg(ctx, specRef, "spec_ref");
        if (resolved.entity.kind !== "spec") {
          throw new ValidationError(
            `register_issue: spec_ref must resolve to a Spec; got ${resolved.entity.kind}.`,
          );
        }
        const { memexId, doc, slugs } = resolved;
        const created = await createIssue({
          memexId,
          docId: doc.id,
          title,
          body,
          type,
          severity,
          source: "agent",
          createdByUserId: ctx.userId,
        });
        const issueRef = buildChildRef(slugs, doc, { type: "issues", seq: created.seq });
        if (ctx.verbose) {
          return `Registered Issue ${issueRef} (${type}, status=${created.status}) on ${doc.handle}: "${title}".`;
        }
        return `ref: ${issueRef} [${type}, ${created.status}]`;
      }

      // ── Homeless path: NO Spec ref. We never silently invent a home (std-5). ──
      const memexId = await ctx.resolveMemex(input.memex as string | undefined);

      // Option (1): promote — turn the issue into its OWN new root Spec, persist no
      // Issue row (ac-28: root Spec, parent_doc_id NULL, no orphan Issue).
      if (promoteToSpecOpt) {
        const spec = await createDocDraft(
          memexId,
          title,
          body,
          "spec",
          undefined,
          undefined,
          ctx.userId,
          reqCtx(ctx),
        );
        const slugs = await memexSlugsById(memexId);
        const specRefOut = slugs ? buildDocRef(slugs, spec) : spec.handle;
        if (ctx.verbose) {
          return `Turned the issue into a new root Spec ref: ${specRefOut} "${spec.title}". No Issue row was persisted — the issue is now the Spec.`;
        }
        return `Spec created from issue: ref: ${specRefOut} "${spec.title}".`;
      }

      // No promote flag → return the two-option assist. PERSIST NOTHING (ac-25/ac-26).
      // Option (2) ranking is delegated to suggestActiveSpecsForIssue (below) so the
      // vector-path ranking + active-only filter (ac-27) is testable in isolation.
      const provider = resolveEmbeddingProvider();
      const activeSpecHits = await suggestActiveSpecsForIssue(
        memexId,
        title,
        body,
        provider,
        5,
      );

      const optionTwo =
        activeSpecHits.length > 0
          ? activeSpecHits
              .map(
                (h, i) =>
                  `   ${i + 1}. ${h.path} — "${h.title}" (${h.status}) — call register_issue again with spec_ref: "${h.path}"`,
              )
              .join("\n")
          : "   (no active Spec matched the issue text — use option 1, or name a spec_ref explicitly)";

      return (
        `No Spec ref supplied — an Issue is never persisted without a home (std-5). ` +
        `Nothing was created. Pick where this Issue lives:\n\n` +
        `(1) Turn it into its OWN new Spec — call register_issue again with promote_to_spec: true ` +
        `(creates a root Spec seeded from the issue; no separate Issue row).\n\n` +
        `(2) Link it to the best-suited active Spec — call register_issue again with one of these spec_ref values:\n` +
        optionTwo
      );
    },
  },
  {
    name: "list_issues",
    annotations: { title: "List issues", readOnlyHint: true, destructiveHint: false },
    description:
      "List the Issues registered on a Spec, optionally filtered by `type` ('bug' | 'todo') or " +
      "`status` ('open' | 'converted' | 'resolved' | 'wont_fix'). Ordered by `issue-N` handle.",
    schema: {
      ref: z.string().describe("Canonical ref to the Spec, e.g. `mindset/main/specs/spec-3`."),
      type: z.enum(["bug", "todo"]).optional().describe("Filter by Issue type."),
      status: z
        .enum(["open", "converted", "resolved", "wont_fix"])
        .optional()
        .describe("Filter by Issue status."),
      verbose: VERBOSE_FIELD,
    },
    async handler(input, ctx) {
      const ref = input.ref as string;
      const type = input.type as IssueType | undefined;
      const status = input.status as IssueStatus | undefined;

      const resolved = await resolveRefArg(ctx, ref);
      if (resolved.entity.kind !== "spec") {
        throw new ValidationError(
          `list_issues expects a Spec ref; got ${resolved.entity.kind}.`,
        );
      }
      const { memexId, doc, slugs } = resolved;
      const rows = await listIssuesForSpec(memexId, doc.id, { type, status });
      if (rows.length === 0) {
        return `No Issues on ${slugs.namespace}/${slugs.memex}/specs/${doc.handle} matching the filter.`;
      }
      const lines = rows.map((r) => {
        const issueRef = buildChildRef(slugs, doc, { type: "issues", seq: r.seq });
        const sev = r.severity ? `, ${r.severity}` : "";
        return `- ref: ${issueRef} [${r.type}, ${r.status}${sev}] "${r.title}"`;
      });
      return `${rows.length} Issue${rows.length === 1 ? "" : "s"}\n${lines.join("\n")}`;
    },
  },
  {
    name: "get_issue",
    annotations: { title: "Get issue", readOnlyHint: true, destructiveHint: false },
    description:
      "Get a single Issue by canonical ref. Returns the type, status, severity, title, and " +
      "(in verbose mode) the body.",
    schema: {
      ref: z.string().describe("Canonical ref to the Issue, e.g. `mindset/main/specs/spec-3/issues/issue-2`."),
      verbose: VERBOSE_FIELD,
    },
    async handler(input, ctx) {
      const ref = input.ref as string;
      const resolved = await resolveRefArg(ctx, ref);
      if (resolved.entity.kind !== "issue") {
        throw new ValidationError(
          `get_issue expects an issue ref; got ${resolved.entity.kind}.`,
        );
      }
      const { memexId, doc, slugs, entity } = resolved;
      // Re-fetch through the service so tenancy is asserted in the service layer
      // (std-7) rather than relied on from the resolver alone.
      const issue = await getIssueById(memexId, entity.row.id);
      const issueRef = buildChildRef(slugs, doc, { type: "issues", seq: issue.seq });
      const sev = issue.severity ? `, ${issue.severity}` : "";
      if (ctx.verbose) {
        return `ref: ${issueRef} [${issue.type}, ${issue.status}${sev}] "${issue.title}"\n\n${issue.body}`;
      }
      return `ref: ${issueRef} [${issue.type}, ${issue.status}${sev}] "${issue.title}"`;
    },
  },
  {
    name: "update_issue",
    annotations: { title: "Update issue", readOnlyHint: false, destructiveHint: false },
    description:
      "Update an Issue's editable fields: `title`, `body`, and/or `severity`. To change an Issue's " +
      "status to resolved/wont_fix, use `resolve_issue`.",
    schema: {
      ref: z.string().describe("Canonical ref to the Issue, e.g. `mindset/main/specs/spec-3/issues/issue-2`."),
      title: z.string().optional().describe("New one-line summary."),
      body: z.string().optional().describe("New detail/body."),
      severity: z.string().optional().describe("New free-text severity (e.g. low / medium / high / critical)."),
      verbose: VERBOSE_FIELD,
    },
    async handler(input, ctx) {
      const ref = input.ref as string;
      const resolved = await resolveRefArg(ctx, ref);
      if (resolved.entity.kind !== "issue") {
        throw new ValidationError(
          `update_issue expects an issue ref; got ${resolved.entity.kind}.`,
        );
      }
      const { memexId, doc, slugs, entity } = resolved;
      const updated = await updateIssue(memexId, entity.row.id, {
        title: input.title as string | undefined,
        body: input.body as string | undefined,
        severity: input.severity as string | undefined,
      });
      const issueRef = buildChildRef(slugs, doc, { type: "issues", seq: updated.seq });
      const sev = updated.severity ? `, ${updated.severity}` : "";
      if (ctx.verbose) {
        return `Updated Issue ${issueRef} [${updated.type}, ${updated.status}${sev}] "${updated.title}".`;
      }
      return `ref: ${issueRef} [${updated.type}, ${updated.status}${sev}]`;
    },
  },
  {
    name: "resolve_issue",
    annotations: { title: "Resolve issue", readOnlyHint: false, destructiveHint: false },
    description:
      "Close out an Issue by transitioning its status to `resolved` (the work is done) or " +
      "`wont_fix` (a deliberate decision not to address it). Use `resolution: 'resolved'` or " +
      "`resolution: 'wont_fix'`.",
    schema: {
      ref: z.string().describe("Canonical ref to the Issue, e.g. `mindset/main/specs/spec-3/issues/issue-2`."),
      resolution: z.enum(["resolved", "wont_fix"]).describe(
        "Target terminal status: `resolved` (addressed) or `wont_fix` (deliberately not addressed).",
      ),
      verbose: VERBOSE_FIELD,
    },
    async handler(input, ctx) {
      const ref = input.ref as string;
      const resolution = input.resolution as "resolved" | "wont_fix";
      const resolved = await resolveRefArg(ctx, ref);
      if (resolved.entity.kind !== "issue") {
        throw new ValidationError(
          `resolve_issue expects an issue ref; got ${resolved.entity.kind}.`,
        );
      }
      const { memexId, doc, slugs, entity } = resolved;
      const updated = await updateIssueStatus(memexId, entity.row.id, resolution);
      const issueRef = buildChildRef(slugs, doc, { type: "issues", seq: updated.seq });
      if (ctx.verbose) {
        return `Resolved Issue ${issueRef} → status=${updated.status} "${updated.title}".`;
      }
      return `ref: ${issueRef} [${updated.type}, ${updated.status}]`;
    },
  },
  {
    name: "convert_issue_to_task",
    annotations: { title: "Convert issue to task", readOnlyHint: false, destructiveHint: false },
    description:
      "Down-bridge: pull an open Issue into an agent Task. ONE atomic operation — it creates the " +
      "Task (seeded from the Issue's title/body/type/severity), mints a verifying implementation " +
      "AC stating the Issue's expected behaviour (parented to the Issue), links the Task to that AC, " +
      "and sets the Issue → converted. A bug-Issue's AC starts RED: write the " +
      "failing reproduction test first, then fix until it goes GREEN — the Issue then auto-resolves " +
      "(converted→resolved) exactly when the Task is complete AND the AC's latest test event is a pass. " +
      "Partial failure rolls everything back.",
    schema: {
      ref: z.string().describe("Canonical ref to the open Issue, e.g. `mindset/main/specs/spec-3/issues/issue-2`."),
      verbose: VERBOSE_FIELD,
    },
    async handler(input, ctx) {
      const ref = input.ref as string;
      const resolved = await resolveRefArg(ctx, ref);
      if (resolved.entity.kind !== "issue") {
        throw new ValidationError(
          `convert_issue_to_task expects an issue ref; got ${resolved.entity.kind}.`,
        );
      }
      const { memexId, doc, slugs, entity } = resolved;
      const result = await convertIssueToTask(memexId, entity.row.id, reqCtx(ctx));
      const taskRef = buildChildRef(slugs, doc, { type: "tasks", seq: result.task.seq });
      const issueRef = buildChildRef(slugs, doc, { type: "issues", seq: result.issue.seq });
      if (ctx.verbose) {
        return (
          `Converted Issue ${issueRef} → Task ${taskRef} "${result.task.title}" (status=not_started). ` +
          `Minted a verifying implementation AC and linked it. The Issue is now status=converted; it ` +
          `auto-resolves when the Task is complete and the AC's latest test event passes.`
        );
      }
      return `ref: ${taskRef} [task, not_started] (from issue ${issueRef}, now converted)`;
    },
  },
  {
    name: "kick_task_to_issue",
    annotations: { title: "Kick task to issue", readOnlyHint: false, destructiveHint: true },
    description:
      "Up-bridge (the FOURTH escalation shape): when an agent Task hits agent-impossible work that " +
      "needs offline / human / external action, push it back up into a human Todo Issue and DELETE the " +
      "dead Task — the durable record becomes the Issue. Pass `reason` describing the offline work " +
      "needed. If the Task originated from an issue→task conversion, the ORIGIN Issue is reverted " +
      "converted→open (with the reason folded in) instead of creating a duplicate — one Issue, not two.",
    schema: {
      ref: z.string().describe("Canonical ref to the agent Task, e.g. `mindset/main/specs/spec-3/tasks/t-2`."),
      reason: z.string().describe(
        "Why the agent cannot complete this Task — the offline / human / external work that's needed.",
      ),
      verbose: VERBOSE_FIELD,
    },
    async handler(input, ctx) {
      const ref = input.ref as string;
      const reason = input.reason as string;
      const resolved = await resolveRefArg(ctx, ref);
      if (resolved.entity.kind !== "task") {
        throw new ValidationError(
          `kick_task_to_issue expects a task ref; got ${resolved.entity.kind}.`,
        );
      }
      const { memexId, doc, slugs, entity } = resolved;
      const result = await kickTaskToIssue(memexId, entity.row.id, reason);
      const issueRef = buildChildRef(slugs, doc, { type: "issues", seq: result.issue.seq });
      if (ctx.verbose) {
        return result.reverted
          ? `Kicked Task t-${(entity.row as { seq: number }).seq} back: reverted its origin Issue ${issueRef} → open (note folded in) and deleted the Task. One Issue, not two.`
          : `Kicked Task t-${(entity.row as { seq: number }).seq} back: created open todo Issue ${issueRef} "${result.issue.title}" on ${doc.handle} and deleted the Task.`;
      }
      return `ref: ${issueRef} [todo, open]${result.reverted ? " (reverted origin)" : ""} (task deleted)`;
    },
  },
  {
    name: "search_issues",
    annotations: { title: "Search issues", readOnlyHint: true, destructiveHint: false },
    description:
      "Search Issues across the Memex — a scoped wrapper over the unified search restricted to " +
      "`kind: 'issue'`. Returns cross-spec Issue matches ranked by RRF over FTS + vector arms: an " +
      "Issue registered on one Spec is discoverable from another. Excludes archived/paused content " +
      "by default. Use this to spot a pre-existing Issue overlapping work in flight before raising a duplicate.",
    schema: {
      memex: z.string().optional().describe(MEMEX_DESC),
      query: z.string().describe("Free-text query over Issue title + body."),
      includeArchived: z
        .boolean()
        .optional()
        .describe("Include Issues on archived/paused Specs. Default false."),
      limit: z
        .number()
        .int()
        .positive()
        .max(50)
        .optional()
        .describe("Cap on hits returned. Default 8."),
      verbose: VERBOSE_FIELD,
    },
    async handler(input, ctx) {
      const memex = input.memex as string | undefined;
      const query = input.query as string;
      const includeArchived = input.includeArchived as boolean | undefined;
      const limit = input.limit as number | undefined;

      const memexId = await ctx.resolveMemex(memex);
      const provider = resolveEmbeddingProvider();
      const hits = await searchMemex(memexId, query, {
        kind: "issue",
        includeArchived,
        limit,
        provider,
      });
      return formatSearchResults(query, hits, { verbose: ctx.verbose });
    },
  },

  // ── Roles + assignment (spec-118) ─────────────────────────
  // Per-Spec roles (editor | reviewer) and ticket-style assignment are TWO
  // independent axes (dec-3). Role decides capability + UI posture on a single
  // Spec and sits ABOVE the org access gate (std-4) — it never narrows read
  // access. Storage carries only elevated rows: an 'editor' row exists or the
  // member resolves to the implicit 'reviewer' default, so reading never writes
  // a row, promote is an idempotent INSERT, demote is a DELETE, and a Spec may
  // hold zero editors (dec-5/dec-6, ac-16). Assignment is a separate relation —
  // assigning never implies a role and is allowed for any active org member,
  // including a reviewer (ac-12). Every write flows through mutate() and emits
  // on the unified bus (std-8, ac-20). Tenancy is 404-not-403 via the service
  // layer (std-7). A USER target is given as an email or a user id.
];
