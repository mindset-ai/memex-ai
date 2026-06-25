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
import { db, sqlClient } from "../db/connection.js";
import { docComments, docSections, activityLog } from "../db/schema.js";
import type { DocComment } from "../db/schema.js";
import type { CommentAction } from "../types/roles.js";
import { NotFoundError, ValidationError } from "../types/errors.js";
import { resolveComment, unresolveComment } from "./comments.js";
import { updateSection } from "./sections.js";
import { mutate, type RequestCtx } from "./mutate.js";
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
  // spec-259 ac-4: the acting user, threaded to resolveComment so the ack/dismiss
  // resolution carries WHO (std-32). Optional — defaults to unattributed.
  ctx?: RequestCtx;
}

export interface ApplyActionResult {
  kind: "dismiss" | "agent";
  comment: DocComment;
  before?: string;
  after?: string;
}

// ── Per-doc serialization (spec §3: one agent action at a time per spec) ──
// spec-350 (REFACTOR, parent audit spec-345 perf-4): the original guard was a
// process-local `Map<docId, Promise>` promise-chain. That serialises within ONE
// Node process only — and prod runs up to 3 Cloud Run instances behind the LB,
// so two instances handling concurrent comment-actions on the SAME source doc
// could interleave their edits and corrupt marker/ordering state. The fix moves
// serialisation into Postgres (shared by every instance) via an advisory lock
// keyed by the doc id, so same-doc actions serialise across the whole fleet
// while different-doc actions stay fully parallel.
//
// ── Why a SESSION-scoped lock on a reserved connection (not pg_advisory_xact_lock) ──
// The spec sketched `pg_advisory_xact_lock(<bigint>)` inside the mutating
// transaction. A transaction-scoped lock auto-releases on COMMIT/ROLLBACK, which
// is the safer primitive — BUT it only protects writes that live in the SAME
// transaction as the lock. Here the critical section is NOT one transaction: it
// runs the agent edit (`runEdit`) and then calls updateSection() + resolveComment()
// + the audit insert — each of which opens its OWN mutate()-wrapped pool
// transaction (std-8). Folding all of those onto a single shared `tx` would mean
// duplicating updateSection's ownership/attribution/re-embed logic and
// resolveComment's attribution inline — drift-prone, and re-licensing well-tested
// seams. Worse, holding ONE pool connection open across those inner writes while
// THEY each need a pool connection is exactly the connection-starvation deadlock
// default-standards.ts documents from spec-184 ("Do NOT 'fix' that with a held
// advisory lock … starves the small connection pool … deadlocks the test suite").
//
// So we take a SESSION-scoped `pg_advisory_lock` on a DEDICATED reserved
// connection (sqlClient.reserve()). That connection holds ONLY the lock; the
// inner writes draw from the rest of the pool (max 5; ≥4 free), so there is no
// starvation — the precise distinction from the spec-184 case, where the held
// connection was also needed by the inner writes. The lock is released in
// `finally` (pg_advisory_unlock) and the connection released back to the pool;
// even on a crash the session lock auto-releases when the backend connection
// drops, so it cannot leak indefinitely. Cross-instance serialisation holds
// because the lock lives in shared Postgres, not in any one Node process.
//
// Key derivation: pg_advisory_lock takes a single signed bigint. We derive it
// from the doc UUID with Postgres' own `hashtextextended(text, 0)` (a stable
// 64-bit hash), computed server-side so it is identical on every instance. Doc
// ids are UUIDs (high entropy), so advisory-key collisions across distinct docs
// are vanishingly unlikely and harmless even if they occurred (two unrelated
// docs would merely serialise against each other — never corrupt data).
async function withDocLock<T>(docId: string, fn: () => Promise<T>): Promise<T> {
  // Reserve a dedicated connection so the lock is held on a session that is NOT
  // contended by the inner writes (which use the rest of the pool).
  const conn = await sqlClient.reserve();
  try {
    await conn`SELECT pg_advisory_lock(hashtextextended(${docId}, 0))`;
    return await fn();
  } finally {
    // Best-effort explicit release; the lock would also drop when the reserved
    // connection is released/closed, but unlocking keeps the session reusable.
    try {
      await conn`SELECT pg_advisory_unlock(hashtextextended(${docId}, 0))`;
    } finally {
      conn.release();
    }
  }
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
    const resolved = await resolveComment(memexId, commentId, `Dismissed via "${actionLabel}".`, deps.ctx ?? {});
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
      deps.ctx ?? {},
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
