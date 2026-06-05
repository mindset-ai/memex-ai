import { and, eq, isNull, asc, inArray } from "drizzle-orm";
import { db } from "../db/connection.js";
import { documents, docComments, docSections, decisions, tasks } from "../db/schema.js";
import { NotFoundError } from "../types/errors.js";

// Doc-12 t-5 — at-a-glance open-comment view for a Spec.
//
// Returns an oldest-first list of open comments with target resolution
// (section / decision / task handle + title) and a per-type breakdown. The
// agent uses this when the user asks "what's outstanding on this Spec?"

export type CommentTargetKind = "section" | "decision" | "task";

export interface OpenComment {
  commentId: string;
  type: string;
  target: {
    kind: CommentTargetKind;
    handle: string;
    title: string | null;
  };
  author: string;
  contentSnippet: string;
  createdAt: Date;
}

export interface CommentsStatus {
  briefId: string;
  specHandle: string;
  specTitle: string;
  totalOpen: number;
  byType: {
    /** "Note" in the UI — schema-level type is `discussion` (the default human-freeform comment). */
    note: number;
    question: number;
    drift: number;
    plan_revision: number;
    /** Catch-all for any other commentType the schema allows now or later (plan / progress / issue / cross_reference / review / readiness_check / approval / deferred). */
    other: number;
  };
  /** Open comments, oldest-first. */
  comments: OpenComment[];
}

const SNIPPET_MAX = 120;

function snippet(content: string): string {
  if (content.length <= SNIPPET_MAX) return content;
  return `${content.slice(0, SNIPPET_MAX).trimEnd()}…`;
}

/**
 * Build the open-comment status view for a Spec.
 *
 * Sort: oldest-first by createdAt (so the agent surfaces stale comments first).
 * Spec-only context but works for any docType — non-Specs just look
 * empty when nothing's targeted at their entities.
 */
export async function assessCommentsStatus(
  memexId: string,
  briefId: string,
): Promise<CommentsStatus> {
  const spec = await db.query.documents.findFirst({
    where: and(eq(documents.id, briefId), eq(documents.memexId, memexId)),
  });
  if (!spec) {
    throw new NotFoundError(`Spec ${briefId} not found`);
  }

  // Pull the entity ids belonging to this Spec; comments have XOR targeting,
  // so we look up by sectionId / decisionId / taskId and resolve handle + title
  // for each match.
  const sectionRows = await db
    .select({ id: docSections.id, sectionType: docSections.sectionType, title: docSections.title })
    .from(docSections)
    .where(eq(docSections.docId, briefId));
  const decisionRows = await db
    .select({ id: decisions.id, seq: decisions.seq, title: decisions.title })
    .from(decisions)
    .where(and(eq(decisions.docId, briefId), eq(decisions.memexId, memexId)));
  const taskRows = await db
    .select({ id: tasks.id, seq: tasks.seq, title: tasks.title })
    .from(tasks)
    .where(and(eq(tasks.docId, briefId), eq(tasks.memexId, memexId)));

  const sectionIds = sectionRows.map((s) => s.id);
  const decisionIds = decisionRows.map((d) => d.id);
  const taskIds = taskRows.map((t) => t.id);

  // Lookup tables for handle/title resolution.
  const sectionById = new Map(
    sectionRows.map((s) => [
      s.id,
      { handle: s.sectionType, title: s.title } as { handle: string; title: string | null },
    ]),
  );
  const decisionById = new Map(
    decisionRows.map((d) => [
      d.id,
      { handle: `dec-${d.seq}`, title: d.title } as { handle: string; title: string | null },
    ]),
  );
  const taskById = new Map(
    taskRows.map((t) => [
      t.id,
      { handle: `t-${t.seq}`, title: t.title } as { handle: string; title: string | null },
    ]),
  );

  // Pull open comments for each target set in parallel, then merge & sort.
  const queries: Promise<typeof allRows>[] = [];
  type Row = {
    id: string;
    commentType: string;
    sectionId: string | null;
    decisionId: string | null;
    taskId: string | null;
    authorName: string;
    content: string;
    createdAt: Date;
  };
  let allRows: Row[] = [];

  if (sectionIds.length > 0) {
    queries.push(
      db
        .select({
          id: docComments.id,
          commentType: docComments.commentType,
          sectionId: docComments.sectionId,
          decisionId: docComments.decisionId,
          taskId: docComments.taskId,
          authorName: docComments.authorName,
          content: docComments.content,
          createdAt: docComments.createdAt,
        })
        .from(docComments)
        .where(
          and(
            eq(docComments.memexId, memexId),
            isNull(docComments.resolvedAt),
            inArray(docComments.sectionId, sectionIds),
          ),
        )
        .orderBy(asc(docComments.createdAt)),
    );
  }
  if (decisionIds.length > 0) {
    queries.push(
      db
        .select({
          id: docComments.id,
          commentType: docComments.commentType,
          sectionId: docComments.sectionId,
          decisionId: docComments.decisionId,
          taskId: docComments.taskId,
          authorName: docComments.authorName,
          content: docComments.content,
          createdAt: docComments.createdAt,
        })
        .from(docComments)
        .where(
          and(
            eq(docComments.memexId, memexId),
            isNull(docComments.resolvedAt),
            inArray(docComments.decisionId, decisionIds),
          ),
        )
        .orderBy(asc(docComments.createdAt)),
    );
  }
  if (taskIds.length > 0) {
    queries.push(
      db
        .select({
          id: docComments.id,
          commentType: docComments.commentType,
          sectionId: docComments.sectionId,
          decisionId: docComments.decisionId,
          taskId: docComments.taskId,
          authorName: docComments.authorName,
          content: docComments.content,
          createdAt: docComments.createdAt,
        })
        .from(docComments)
        .where(
          and(
            eq(docComments.memexId, memexId),
            isNull(docComments.resolvedAt),
            inArray(docComments.taskId, taskIds),
          ),
        )
        .orderBy(asc(docComments.createdAt)),
    );
  }

  const results = await Promise.all(queries);
  for (const r of results) allRows = allRows.concat(r);
  // Final merge sort across the three target slices.
  allRows.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());

  const byType = { note: 0, question: 0, drift: 0, plan_revision: 0, other: 0 };
  const comments: OpenComment[] = [];
  for (const r of allRows) {
    let target: OpenComment["target"] | null = null;
    if (r.sectionId && sectionById.has(r.sectionId)) {
      const t = sectionById.get(r.sectionId)!;
      target = { kind: "section", handle: t.handle, title: t.title };
    } else if (r.decisionId && decisionById.has(r.decisionId)) {
      const t = decisionById.get(r.decisionId)!;
      target = { kind: "decision", handle: t.handle, title: t.title };
    } else if (r.taskId && taskById.has(r.taskId)) {
      const t = taskById.get(r.taskId)!;
      target = { kind: "task", handle: t.handle, title: t.title };
    }
    if (!target) continue; // shouldn't happen given the WHERE clauses, but be defensive

    switch (r.commentType) {
      case "discussion":
        // Spec calls these "note" — they're the default human freeform comments.
        byType.note += 1;
        break;
      case "question":
        byType.question += 1;
        break;
      case "drift":
        byType.drift += 1;
        break;
      case "plan_revision":
        byType.plan_revision += 1;
        break;
      default:
        byType.other += 1;
    }

    comments.push({
      commentId: r.id,
      type: r.commentType,
      target,
      author: r.authorName,
      contentSnippet: snippet(r.content),
      createdAt: r.createdAt,
    });
  }

  return {
    // `briefId` field name preserved under the b-105 wire-format allowlist.
    briefId: spec.id,
    specHandle: spec.handle,
    specTitle: spec.title,
    totalOpen: comments.length,
    byType,
    comments,
  };
}
