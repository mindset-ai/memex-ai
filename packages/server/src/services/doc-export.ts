// spec-100 §4 / ac-5: doc-level export form. Loads every (non-deleted) section
// of a spec and its section comments, then renders the whole document in export
// form — each `[^c-N]` marker expanded inline into an HTML-comment-delimited
// block-quote, floating comments appended per section. This is the lossless
// markdown a user can paste into an external LLM or editor with the
// conversation intact, and the same form fed to the in-Memex side agent.
//
// The per-section serialization is the pure function in export-form.ts; this
// module is the thin DB-loading wrapper around it.

import { and, eq, inArray } from "drizzle-orm";
import { db } from "../db/connection.js";
import { documents, docSections, docComments } from "../db/schema.js";
import type { DocComment } from "../db/schema.js";
import { NotFoundError } from "../types/errors.js";
import { serializeSectionToExportForm, type ExportComment } from "./export-form.js";

function toExportComment(c: DocComment): ExportComment {
  return {
    seq: c.seq,
    authorName: c.authorName,
    commentType: c.commentType,
    resolvedAt: c.resolvedAt,
    createdAt: c.createdAt,
    anchorSnippet: c.anchorSnippet,
    content: c.content,
  };
}

export async function buildDocExportForm(memexId: string, docId: string): Promise<string> {
  const doc = await db.query.documents.findFirst({
    where: and(eq(documents.id, docId), eq(documents.memexId, memexId)),
  });
  if (!doc) {
    throw new NotFoundError(`Document ${docId} not found`);
  }

  const sections = (
    await db.query.docSections.findMany({
      where: eq(docSections.docId, docId),
      orderBy: (s, { asc }) => [asc(s.seq)],
    })
  ).filter((s) => s.status !== "deleted");

  const sectionIds = sections.map((s) => s.id);
  const comments =
    sectionIds.length > 0
      ? await db.query.docComments.findMany({
          where: inArray(docComments.sectionId, sectionIds),
          orderBy: (c, { asc }) => [asc(c.createdAt)],
        })
      : [];

  const blocks = sections.map((s) => {
    const own = comments.filter((c) => c.sectionId === s.id).map(toExportComment);
    const heading = `## ${s.title ?? s.sectionType}`;
    return `${heading}\n\n${serializeSectionToExportForm(s.content, own)}`;
  });

  return `# ${doc.title}\n\n${blocks.join("\n\n")}`;
}
