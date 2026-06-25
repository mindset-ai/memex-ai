// Service layer for comment @-mentions + assignment (spec-320).
//
// Three concepts stay distinct (dec-1): audience (visibility) lives on
// doc_comments.audience untouched; MENTION (attention) is the comment_mentions
// join table; ASSIGNEE (ownership) is the assignee_user_id/assigned_by/assigned_at
// columns on doc_comments. A single comment can be audience='all', @-mention
// several people, and be assigned to one of them — all at once (ac-3).
//
// Assign = mention + ownership (dec-2): assigning a comment ALWAYS guarantees a
// matching comment_mentions row (assignee ⊆ mentions), so comment_mentions is the
// uniform "everyone called out" set and assignee_user_id just marks the owner. The
// open→resolved lifecycle reuses the comment's existing resolved_at/resolution
// (services/comments.ts resolveComment) — the assignee resolving the comment closes
// the assignment, so no assignment-specific status column exists.
//
// Writes flow through mutate() and emit on the unified bus (std-8): mention-add
// emits comment_mention created; assign/unassign emit comment_assignee created/
// deleted. WHO/WHEN ride the activity contract (std-32) via resolveActorColumns.
//
// Notifications (dec-3): a mention-add sends ONE mention email per newly-mentioned
// user; an assignment sends ONE assignment email to the assignee (never both — the
// assignee, being mention+ownership, gets only the stronger assignment signal).
// Emails are fire-and-forget and can never break the write.

import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { db } from "../db/connection.js";
import { commentMentions, docComments, documents, users } from "../db/schema.js";
import type { CommentMention, DocComment } from "../db/schema.js";
import { NotFoundError } from "../types/errors.js";
import { mutate, type Mutated, type RequestCtx } from "./mutate.js";
import { actorName, resolveActorColumns } from "./actor.js";
import { getEmailSender } from "./email/sender.js";
import { buildMentionEmail, buildAssignmentEmail } from "./email/templates.js";

// Same default as routes/auth/helpers.ts — read directly so this service doesn't
// depend on the route layer for an env value.
const APP_BASE_URL = process.env.APP_BASE_URL ?? "http://localhost:5173";

// docType → URL path segment. Mirrors services/memex-search.ts docTypeToPathSegment
// (kept local to avoid widening that module's export surface).
function docTypeToPathSegment(docType: string): string {
  if (docType === "spec") return "specs";
  if (docType === "standard") return "standards";
  if (docType === "execution_plan") return "execution-plans";
  return "docs";
}

// Load a comment and assert it lives in the given memex (404 on a cross-tenant
// miss, std-7). doc_comments carries docId + seq denormalised, so this is the only
// lookup the mention/assign paths need before mutating.
async function loadComment(memexId: string, commentId: string): Promise<DocComment> {
  const comment = await db.query.docComments.findFirst({
    where: and(eq(docComments.id, commentId), eq(docComments.memexId, memexId)),
  });
  if (!comment) {
    throw new NotFoundError(`Comment ${commentId} not found`);
  }
  return comment;
}

interface CommentEmailContext {
  specLabel: string;
  commentUrl: string;
}

// Build the deep-link + human label an email needs from a comment. Best-effort:
// returns null if the parent doc/memex can't be resolved, so a missing context
// silently skips the email rather than throwing on the write path.
async function resolveCommentEmailContext(
  memexId: string,
  comment: DocComment,
): Promise<CommentEmailContext | null> {
  const doc = await db.query.documents.findFirst({
    where: and(eq(documents.id, comment.docId), eq(documents.memexId, memexId)),
    columns: { handle: true, title: true, docType: true },
  });
  if (!doc) return null;

  const slugRows = (await db.execute(sql`
    SELECT n.slug AS namespace_slug, m.slug AS memex_slug
    FROM memexes m
    INNER JOIN namespaces n ON n.id = m.namespace_id
    WHERE m.id = ${memexId}
    LIMIT 1
  `)) as unknown as { namespace_slug: string; memex_slug: string }[];
  const slugs = slugRows[0];
  if (!slugs) return null;

  const seg = docTypeToPathSegment(doc.docType);
  const base = APP_BASE_URL.replace(/\/$/, "");
  const commentUrl = `${base}/${slugs.namespace_slug}/${slugs.memex_slug}/${seg}/${doc.handle}?comment=c-${comment.seq}`;
  const specLabel = doc.title ? `${doc.handle} — ${doc.title}` : doc.handle;
  return { specLabel, commentUrl };
}

// Fire-and-forget: never throws, never blocks the write (dec-3). A send failure is
// logged and swallowed (mirrors the auth email callers).
function sendEmailSafe(message: { to: string; subject: string; text: string; html?: string }): void {
  void getEmailSender()
    .send(message)
    .catch((err) => console.error("Failed to send comment notification email:", err));
}

// ── Mention capture (dec-1, ac-1) ───────────────────────────────────────────

export interface MentionView {
  userId: string;
  name: string | null;
  email: string | null;
  at: Date;
}

// @-mention one or more users in a comment. Idempotent per (comment_id, user_id):
// re-mentioning an already-mentioned user is a no-op that emits nothing and
// re-sends no email. Each NEWLY-mentioned user gets one comment_mention event and
// one mention email (the mentioner themselves is never emailed). Returns the rows
// that were actually inserted (empty when every user was already mentioned).
export async function addMentions(
  memexId: string,
  commentId: string,
  userIds: string[],
  ctx: RequestCtx = {},
): Promise<CommentMention[]> {
  const distinct = [...new Set(userIds)].filter((u) => u && u.length > 0);
  if (distinct.length === 0) return [];

  const comment = await loadComment(memexId, commentId);

  const existing = await db
    .select({ userId: commentMentions.userId })
    .from(commentMentions)
    .where(and(eq(commentMentions.memexId, memexId), eq(commentMentions.commentId, commentId)));
  const already = new Set(existing.map((r) => r.userId));
  const newUserIds = distinct.filter((u) => !already.has(u));
  if (newUserIds.length === 0) return [];

  const actor = await resolveActorColumns(ctx);
  const mentionedBy = actor.actorUserId ?? null;

  // Resolve the parent doc handle + the new users' display names for the per-row
  // Pulse narrative (spec-122 — name the spec + person, never leak the UUID).
  const doc = await db.query.documents.findFirst({
    where: and(eq(documents.id, comment.docId), eq(documents.memexId, memexId)),
    columns: { handle: true },
  });
  const handle = doc?.handle ?? "a comment";
  const people = await db.query.users.findMany({
    where: inArray(users.id, newUserIds),
    columns: { id: true, name: true, email: true },
  });
  const byId = new Map(people.map((p) => [p.id, p]));

  const inserted = await mutate(
    { ...ctx, actorUserId: actor.actorUserId ?? undefined, actorName: actor.actorName ?? undefined },
    newUserIds.map((userId) => ({
      memexId,
      docId: comment.docId,
      entity: "comment_mention" as const,
      action: "created" as const,
      narrative: `mentioned ${actorName(byId.get(userId) ?? { name: null, email: "a member" })} on ${handle}`,
    })),
    async () => {
      const rows = await db
        .insert(commentMentions)
        .values(newUserIds.map((userId) => ({ memexId, commentId, userId, mentionedBy })))
        .onConflictDoNothing()
        .returning();
      return rows;
    },
  );

  // Notify each newly-mentioned user (never the mentioner themselves).
  const emailCtx = await resolveCommentEmailContext(memexId, comment);
  if (emailCtx) {
    const mentionerName = actor.actorName ?? "Someone";
    for (const userId of newUserIds) {
      if (userId === mentionedBy) continue;
      const u = byId.get(userId);
      if (!u?.email) continue;
      sendEmailSafe(
        buildMentionEmail({
          to: u.email,
          mentionerName,
          specLabel: emailCtx.specLabel,
          commentUrl: emailCtx.commentUrl,
        }),
      );
    }
  }

  return inserted;
}

// ── Assignment (dec-2, ac-2) ─────────────────────────────────────────────────

// Assign a comment to a single owner. Sets assignee_user_id/assigned_by/assigned_at
// AND guarantees the assignee is also a mention row (assignee ⊆ mentions, dec-2) —
// both in one mutate() so the invariant can never be half-written. Emits
// comment_assignee created and sends ONE assignment email (not a mention email).
// Idempotent: re-assigning the same user refreshes assigned_by/at and is harmless.
export async function assignComment(
  memexId: string,
  commentId: string,
  assigneeUserId: string,
  ctx: RequestCtx = {},
): Promise<Mutated<DocComment>> {
  const comment = await loadComment(memexId, commentId);
  const actor = await resolveActorColumns(ctx);
  const assignedBy = actor.actorUserId ?? null;

  const assignee = await db.query.users.findFirst({
    where: eq(users.id, assigneeUserId),
    columns: { id: true, name: true, email: true },
  });
  if (!assignee) {
    throw new NotFoundError(`User ${assigneeUserId} not found`);
  }
  const who = actorName(assignee);
  const doc = await db.query.documents.findFirst({
    where: and(eq(documents.id, comment.docId), eq(documents.memexId, memexId)),
    columns: { handle: true },
  });
  const handle = doc?.handle ?? "a comment";

  const updated = await mutate(
    { ...ctx, actorUserId: actor.actorUserId ?? undefined, actorName: actor.actorName ?? undefined },
    {
      memexId,
      docId: comment.docId,
      entity: "comment_assignee",
      action: "created",
      narrative: `assigned a comment on ${handle} to ${who}`,
    },
    async () => {
      // assignee ⊆ mentions: ensure the mention row first (idempotent), so the
      // ownership marker never points at a non-mentioned user.
      await db
        .insert(commentMentions)
        .values({ memexId, commentId, userId: assigneeUserId, mentionedBy: assignedBy })
        .onConflictDoNothing();
      const [row] = await db
        .update(docComments)
        .set({ assigneeUserId, assignedBy, assignedAt: new Date() })
        .where(and(eq(docComments.id, commentId), eq(docComments.memexId, memexId)))
        .returning();
      return row;
    },
  );

  // One assignment email to the assignee (never a mention email, never to self).
  if (assignee.email && assigneeUserId !== assignedBy) {
    const emailCtx = await resolveCommentEmailContext(memexId, comment);
    if (emailCtx) {
      sendEmailSafe(
        buildAssignmentEmail({
          to: assignee.email,
          assignerName: actor.actorName ?? "Someone",
          specLabel: emailCtx.specLabel,
          commentUrl: emailCtx.commentUrl,
        }),
      );
    }
  }

  return updated;
}

// Clear a comment's assignment (ownership only). Leaves the mention row intact —
// removing ownership does not un-mention the person (assign = mention + ownership;
// stripping ownership leaves the mention). Emits comment_assignee deleted.
export async function unassignComment(
  memexId: string,
  commentId: string,
  ctx: RequestCtx = {},
): Promise<Mutated<DocComment>> {
  const comment = await loadComment(memexId, commentId);
  const actor = await resolveActorColumns(ctx);
  const doc = await db.query.documents.findFirst({
    where: and(eq(documents.id, comment.docId), eq(documents.memexId, memexId)),
    columns: { handle: true },
  });
  const handle = doc?.handle ?? "a comment";

  return mutate(
    { ...ctx, actorUserId: actor.actorUserId ?? undefined, actorName: actor.actorName ?? undefined },
    {
      memexId,
      docId: comment.docId,
      entity: "comment_assignee",
      action: "deleted",
      narrative: `unassigned a comment on ${handle}`,
    },
    async () => {
      const [row] = await db
        .update(docComments)
        .set({ assigneeUserId: null, assignedBy: null, assignedAt: null })
        .where(and(eq(docComments.id, commentId), eq(docComments.memexId, memexId)))
        .returning();
      return row;
    },
  );
}

// ── Reads — rendering + the spec-315 "where you're needed" contract ──────────

// The mentions on a set of comments, joined to users for display. Backs the comment
// tray's mention chips. Returns a Map keyed by commentId (comments with no mentions
// are simply absent).
export async function listMentionsForComments(
  memexId: string,
  commentIds: string[],
): Promise<Map<string, MentionView[]>> {
  const byComment = new Map<string, MentionView[]>();
  if (commentIds.length === 0) return byComment;
  const rows = await db
    .select({
      commentId: commentMentions.commentId,
      userId: commentMentions.userId,
      name: users.name,
      email: users.email,
      at: commentMentions.at,
    })
    .from(commentMentions)
    .innerJoin(users, eq(users.id, commentMentions.userId))
    .where(
      and(eq(commentMentions.memexId, memexId), inArray(commentMentions.commentId, commentIds)),
    )
    .orderBy(commentMentions.at);
  for (const r of rows) {
    const list = byComment.get(r.commentId) ?? [];
    list.push({ userId: r.userId, name: r.name, email: r.email, at: r.at });
    byComment.set(r.commentId, list);
  }
  return byComment;
}

// spec-315 read contract (ac-4) — "mentions-me": every comment in the memex that
// mentions the user, newest mention first. Joined to doc_comments so the caller can
// render a navigable card without a second lookup.
export async function listCommentsMentioningUser(
  memexId: string,
  userId: string,
): Promise<DocComment[]> {
  const rows = await db
    .select({ comment: docComments })
    .from(commentMentions)
    .innerJoin(docComments, eq(docComments.id, commentMentions.commentId))
    .where(and(eq(commentMentions.memexId, memexId), eq(commentMentions.userId, userId)))
    .orderBy(sql`${commentMentions.at} DESC`);
  return rows.map((r) => r.comment);
}

// spec-315 read contract (ac-4) — "assigned-to-me (open)": comments assigned to the
// user that are still open (resolved_at IS NULL). Backed by the partial index
// doc_comments_open_assignee_idx.
export async function listOpenAssignmentsForUser(
  memexId: string,
  userId: string,
): Promise<DocComment[]> {
  return db.query.docComments.findMany({
    where: and(
      eq(docComments.memexId, memexId),
      eq(docComments.assigneeUserId, userId),
      isNull(docComments.resolvedAt),
    ),
    orderBy: (c, { asc }) => [asc(c.assignedAt)],
  });
}
