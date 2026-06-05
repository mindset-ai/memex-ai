// spec-100 §3 (dec-2): execute a system-authored comment action button.
//
// Two kinds (the `kind` field on a CommentAction):
//   - 'dismiss' — resolve the comment, no agent involved.
//   - 'agent'   — run the action's pre-canned prompt through the side agent to
//                 edit the anchored section in place, then auto-resolve the
//                 comment with an audit record and remove its marker.
//
// dec-2 is "apply-with-undo": the edit lands immediately (no accept/reject
// diff gate); `undoCommentAction` reverses it cleanly. The transient undo
// *window* is a UI concern; the server provides the apply + undo capabilities
// and the audit trail.
//
// The marker-preservation gate (spec §3) is enforced HERE rather than trusting
// the agent: if the agent's output drops any OTHER comment's marker, the action
// fails loudly and the spec is left untouched. That is why the apply step lives
// in this service and not in the agent's own update_section call.
//
// Note (spec deviation, flagged): §4 describes the agent receiving the EXPORT
// form. For an *edit* the agent instead receives the STORAGE form (markers
// literal) so it can preserve `[^c-N]` glyphs verbatim per §3 — feeding back
// the export form would require the round-trip that is explicitly out of v0
// scope. The export form remains the read / external-paste path.

import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "../db/connection.js";
import { docComments, docSections, activityLog } from "../db/schema.js";
import type { DocComment } from "../db/schema.js";
import type { CommentAction } from "../types/roles.js";
import { NotFoundError, ValidationError } from "../types/errors.js";
import { resolveComment, unresolveComment } from "./comments.js";
import { updateSection } from "./sections.js";
import { mutate } from "./mutate.js";
import { hasAnchorMarker, extractMarkerSeqs, stripMarkersForSeq } from "./geo-anchor.js";

// What the side agent is handed for an edit, and what it must return (new
// storage-form content for the section). Injected so the orchestration is
// testable without a live LLM; production supplies an Anthropic-backed impl.
export interface AgentEditInput {
  prompt: string;
  sectionContent: string;
  anchorSnippet: string | null;
}
export type AgentEditFn = (input: AgentEditInput) => Promise<string>;

export interface ApplyActionDeps {
  runEdit: AgentEditFn;
  agentName?: string;
}

export interface ApplyActionResult {
  kind: "dismiss" | "agent";
  comment: DocComment;
  before?: string;
  after?: string;
}

// ── Per-doc serialization (spec §3: one agent action at a time per spec) ──
// In-memory promise chain keyed by docId. Subsequent actions on the same doc
// queue behind the in-flight one rather than interleaving edits to the source.
const docLocks = new Map<string, Promise<unknown>>();

async function withDocLock<T>(docId: string, fn: () => Promise<T>): Promise<T> {
  const prior = docLocks.get(docId) ?? Promise.resolve();
  const run = prior.then(fn, fn);
  // Keep the chain alive but swallow this run's result/throw for the *next*
  // waiter — each caller still gets its own result/throw from `run`.
  docLocks.set(
    docId,
    run.then(
      () => undefined,
      () => undefined,
    ),
  );
  return run;
}

function findAction(comment: DocComment, label: string): CommentAction {
  const actions = comment.actions ?? [];
  const action = actions.find((a) => a.label === label);
  if (!action) {
    throw new ValidationError(
      `Comment c-${comment.seq} has no action labelled "${label}".`,
    );
  }
  return action;
}

async function loadOpenComment(memexId: string, commentId: string): Promise<DocComment> {
  const comment = await db.query.docComments.findFirst({
    where: and(eq(docComments.id, commentId), eq(docComments.memexId, memexId)),
  });
  if (!comment) {
    throw new NotFoundError(`Comment ${commentId} not found`);
  }
  if (comment.resolvedAt) {
    throw new ValidationError(`Comment c-${comment.seq} is already resolved.`);
  }
  return comment;
}

// Remove this comment's own anchor sentinels (start + end + legacy) from the
// content — its anchor's purpose is fulfilled once the action resolves it.
function stripOwnMarker(content: string, seq: number): string {
  return stripMarkersForSeq(content, seq);
}

export async function applyCommentAction(
  memexId: string,
  commentId: string,
  actionLabel: string,
  deps: ApplyActionDeps,
): Promise<ApplyActionResult> {
  const comment = await loadOpenComment(memexId, commentId);
  const action = findAction(comment, actionLabel);

  if (action.kind === "dismiss") {
    const resolved = await resolveComment(memexId, commentId, `Dismissed via "${actionLabel}".`);
    return { kind: "dismiss", comment: resolved };
  }

  if (action.kind !== "agent") {
    throw new ValidationError(`Unsupported action kind "${action.kind}".`);
  }
  if (!comment.sectionId) {
    throw new ValidationError("Agent actions are only supported on section-anchored comments in v0.");
  }
  if (!action.prompt) {
    throw new ValidationError(`Action "${actionLabel}" is kind 'agent' but carries no prompt.`);
  }

  const sectionId = comment.sectionId;
  const docId = comment.docId;

  return withDocLock(docId, async () => {
    const section = await db.query.docSections.findFirst({
      where: eq(docSections.id, sectionId),
    });
    if (!section) {
      throw new NotFoundError(`Section ${sectionId} not found`);
    }
    const before = section.content;

    const agentOutput = await deps.runEdit({
      prompt: action.prompt!,
      sectionContent: before,
      anchorSnippet: comment.anchorSnippet,
    });

    // Marker-preservation gate (spec §3): every OTHER comment's marker that was
    // in the section must survive. This comment's own marker is exempt — it is
    // about to be removed on resolve.
    const mustSurvive = extractMarkerSeqs(before).filter((s) => s !== comment.seq);
    const destroyed = mustSurvive.filter((s) => !hasAnchorMarker(agentOutput, s));
    if (destroyed.length > 0) {
      const list = destroyed.map((s) => `c-${s}`).join(", ");
      throw new ValidationError(
        `Agent edit would destroy anchor marker(s): ${list}. The change was not applied.`,
      );
    }

    const after = stripOwnMarker(agentOutput, comment.seq);
    await updateSection(memexId, sectionId, after);

    const agentName = deps.agentName ?? "Memex agent";
    const resolved = await resolveComment(
      memexId,
      commentId,
      `Addressed via "${actionLabel}" by ${agentName}.`,
    );

    // Audit + undo record (spec §3 / ac-8). Wrapped in mutate({ silent: true })
    // to satisfy std-8 §5: this write goes through the single mutation seam (so
    // the doc-21 t-4 static scan holds), but it must NOT re-emit a bus event —
    // the activity log is append-only observability, the same sink persistEvent
    // writes bus events into, so emitting here would be circular. It stores the
    // prior content `undoCommentAction` restores.
    await mutate(
      {},
      { memexId, docId, entity: "comment", action: "updated" },
      () =>
        db.insert(activityLog).values({
          memexId,
          briefId: docId,
          actorKind: "system",
          channel: "server",
          entity: "comment",
          action: "action_applied",
          narrative: `Agent addressed c-${comment.seq} via "${actionLabel}"`,
          payload: { commentId, sectionId, actionLabel, prompt: action.prompt, agent: agentName, before, after },
        }),
      { silent: true },
    );

    return { kind: "agent", comment: resolved, before, after };
  });
}

// Reverse the most recent applied agent action on a comment (dec-2 undo).
// Restores the section's prior content (which re-introduces this comment's
// marker) and re-opens the comment.
export async function undoCommentAction(
  memexId: string,
  commentId: string,
): Promise<DocComment> {
  const [row] = await db
    .select()
    .from(activityLog)
    .where(
      and(
        eq(activityLog.memexId, memexId),
        eq(activityLog.action, "action_applied"),
        sql`${activityLog.payload}->>'commentId' = ${commentId}`,
      ),
    )
    .orderBy(desc(activityLog.createdAt))
    .limit(1);

  if (!row || !row.payload) {
    throw new NotFoundError(`No applied action found for comment ${commentId} to undo.`);
  }
  const payload = row.payload as { sectionId: string; before: string };
  await updateSection(memexId, payload.sectionId, payload.before);
  return unresolveComment(memexId, commentId);
}
