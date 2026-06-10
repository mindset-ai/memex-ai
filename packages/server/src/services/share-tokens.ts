import { and, desc, eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { db, runWithMemexId } from "../db/connection.js";
import {
  shareTokens,
  documents,
  docSections,
  docComments,
  decisions,
  tasks,
  memexes,
  namespaces,
} from "../db/schema.js";
import type { ShareToken, Doc, DocSection, DocComment } from "../db/schema.js";
import { NotFoundError, ValidationError } from "../types/errors.js";
import { mutate, type Mutated, type RequestCtx } from "./mutate.js";
import { assertDocBelongsToMemex } from "./shared/memex-ownership.js";
import { nextSeq, withSeqRetry } from "./shared/sequence.js";

// b-36 T-2: shared-comments now also allocate (doc_id, seq). Same retry
// pattern as services/comments.ts.
const DOC_COMMENTS_SEQ_CONSTRAINT = "doc_comments_doc_seq_unique";

export class ShareTokenError extends ValidationError {
  constructor(
    public readonly reason: "unknown" | "revoked",
    message: string
  ) {
    super(message);
    this.name = "ShareTokenError";
  }
}

// Default TTL for share tokens. Configurable via SHARE_TOKEN_TTL_DAYS; null = no expiry.
function defaultExpiresAt(): Date | null {
  const days = process.env.SHARE_TOKEN_TTL_DAYS
    ? parseInt(process.env.SHARE_TOKEN_TTL_DAYS, 10)
    : 90;
  if (!days || isNaN(days)) return null;
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d;
}

// Creates a cryptographically random share token for the given document.
// Caller (route handler) must enforce that the requester belongs to the document's account.
// createdByUserId is recorded so tokens can be bulk-revoked when a member is removed (spec-199 t-3).
export async function createShareToken(
  memexId: string,
  documentId: string,
  createdByUserId: string | null = null,
): Promise<Mutated<ShareToken>> {
  await assertDocBelongsToMemex(documentId, memexId);

  return mutate(
    {},
    { memexId, docId: documentId, entity: "share_token", action: "created" },
    async () => {
      const token = randomUUID();
      const expiresAt = defaultExpiresAt();
      const [created] = await db
        .insert(shareTokens)
        .values({ documentId, memexId, token, createdByUserId, expiresAt })
        .returning();
      return created;
    },
  );
}

export async function listShareTokensForDoc(
  memexId: string,
  documentId: string
): Promise<ShareToken[]> {
  // Verify doc ownership first so cross-account callers can't enumerate tokens
  await assertDocBelongsToMemex(documentId, memexId);

  return db
    .select()
    .from(shareTokens)
    .where(and(eq(shareTokens.documentId, documentId), eq(shareTokens.revoked, false)))
    .orderBy(desc(shareTokens.createdAt));
}

// Revokes a share token (soft-delete). Verifies ownership by walking token → doc → account.
// Returns the revoked row; throws NotFoundError if the token doesn't exist or isn't owned by the account.
export async function revokeShareToken(
  memexId: string,
  shareId: string
): Promise<Mutated<ShareToken>> {
  const existing = await db.query.shareTokens.findFirst({
    where: eq(shareTokens.id, shareId),
  });
  if (!existing) {
    throw new NotFoundError(`Share ${shareId} not found`);
  }
  const doc = await db.query.documents.findFirst({
    where: and(eq(documents.id, existing.documentId), eq(documents.memexId, memexId)),
  });
  if (!doc) {
    throw new NotFoundError(`Share ${shareId} not found`);
  }

  if (existing.revoked) {
    // Idempotent already-revoked path — no DB write, no observable change.
    return mutate(
      {},
      { memexId, docId: existing.documentId, entity: "share_token", action: "updated" },
      async () => existing,
      { silent: true },
    );
  }

  return mutate(
    {},
    { memexId, docId: existing.documentId, entity: "share_token", action: "updated" },
    async () => {
      const [updated] = await db
        .update(shareTokens)
        .set({ revoked: true })
        .where(eq(shareTokens.id, shareId))
        .returning();
      return updated;
    },
  );
}

export interface SharedDocumentPayload {
  doc: Doc;
  sections: DocSection[];
  namespaceSlug: string;
  memexName: string;
  // Comments on the shared doc, grouped by target (section/decision/task). External comments
  // (where author_namespace_id != doc.memex.namespace_id) will be surfaced with that badge in the UI.
  comments: DocComment[];
}

// PUBLIC endpoint — no auth required. Resolves a share token to the underlying document and
// its sections. Returns distinct error kinds so the UI can show specific messages:
//   - "unknown"  → token never existed or the doc has been deleted (FK cascades)
//   - "revoked"  → token was valid but has been revoked
// Account info is surfaced so the guest UI can render branding like "Shared by Acme Co".
export async function getSharedDocumentByToken(token: string): Promise<SharedDocumentPayload> {
  const tokenRow = await db.query.shareTokens.findFirst({
    where: eq(shareTokens.token, token),
  });
  if (!tokenRow) {
    throw new ShareTokenError("unknown", "Invalid share link");
  }
  if (tokenRow.revoked) {
    throw new ShareTokenError("revoked", "This link has been revoked");
  }
  if (tokenRow.expiresAt && tokenRow.expiresAt < new Date()) {
    throw new ShareTokenError("revoked", "This link has expired");
  }

  // Bootstrap ALS so RLS policies are satisfied: share_tokens is not RLS-gated
  // (no memex_id column in the 0081 policy list), so token resolution works
  // without a context. All subsequent queries hit RLS-protected tables and
  // require app.memex_id to be set, hence the runWithMemexId wrapper below.
  return runWithMemexId(tokenRow.memexId, async () => {
    const doc = await db.query.documents.findFirst({
      where: eq(documents.id, tokenRow.documentId),
    });
    if (!doc) {
      // Should be impossible via CASCADE, but defensive
      throw new ShareTokenError("unknown", "Invalid share link");
    }

    const sections = await db
      .select()
      .from(docSections)
      .where(eq(docSections.docId, doc.id))
      .orderBy(docSections.seq);

    const memex = await db.query.memexes.findFirst({
      where: eq(memexes.id, doc.memexId),
    });
    const ns = memex
      ? await db.query.namespaces.findFirst({
          where: eq(namespaces.id, memex.namespaceId),
        })
      : null;

    // Surface all comments on the doc so external commenters see the thread.
    const comments = await db.query.docComments.findMany({
      where: eq(docComments.memexId, doc.memexId),
      orderBy: (c, { asc }) => [asc(c.createdAt)],
    });

    // Filter to only comments attached to this doc's children (sections/decisions/tasks),
    // to avoid leaking comments from other docs in the same account.
    const sectionIds = new Set(sections.map((s) => s.id));
    const docDecisions = await db.select({ id: decisions.id }).from(decisions).where(eq(decisions.docId, doc.id));
    const decisionIds = new Set(docDecisions.map((d) => d.id));
    const docTasks = await db.select({ id: tasks.id }).from(tasks).where(eq(tasks.docId, doc.id));
    const taskIds = new Set(docTasks.map((w) => w.id));

    const scoped = comments.filter(
      (c) =>
        (c.sectionId && sectionIds.has(c.sectionId)) ||
        (c.decisionId && decisionIds.has(c.decisionId)) ||
        (c.taskId && taskIds.has(c.taskId))
    );

    return {
      doc,
      sections,
      namespaceSlug: ns?.slug ?? "",
      memexName: memex?.name ?? "",
      comments: scoped,
    };
  });
}

export type ShareCommentTarget =
  | { kind: "section"; id: string }
  | { kind: "decision"; id: string }
  | { kind: "task"; id: string };

export interface CreateExternalCommentInput {
  token: string;
  authorUserId: string;
  // Author's own namespace id. Used to render the External badge when the
  // commenter's namespace differs from the doc's memex's namespace.
  authorNamespaceId: string;
  authorName: string;
  target: ShareCommentTarget;
  content: string;
}

// Creates a comment on a shared document from an externally-signed-in user. The token
// itself is the proof of read access; the Bearer credential (resolved by the caller) is
// the attribution. The comment's `memex_id` is pinned to the doc's memex (so it's
// scoped with the rest of the memex's comments), but `author_namespace_id` is the
// commenter's own namespace — rendered with an "External" badge when they differ.
export async function createExternalComment(
  input: CreateExternalCommentInput,
  ctx: RequestCtx = {},
): Promise<Mutated<DocComment>> {
  const tokenRow = await db.query.shareTokens.findFirst({
    where: eq(shareTokens.token, input.token),
  });
  if (!tokenRow) {
    throw new ShareTokenError("unknown", "Invalid share link");
  }
  if (tokenRow.revoked) {
    throw new ShareTokenError("revoked", "This link has been revoked");
  }

  // share.ts has no session middleware, so no ALS context is set. Bootstrap
  // runWithMemexId from the token's memex_id so RLS-gated lookups below succeed.
  return runWithMemexId(tokenRow.memexId, async () => {
  const doc = await db.query.documents.findFirst({
    where: eq(documents.id, tokenRow.documentId),
  });
  if (!doc) {
    throw new ShareTokenError("unknown", "Invalid share link");
  }

  // Verify the target belongs to the shared doc (prevents commenting on a section/task/
  // decision from a DIFFERENT doc via the token).
  if (input.target.kind === "section") {
    const section = await db.query.docSections.findFirst({
      where: and(eq(docSections.id, input.target.id), eq(docSections.docId, doc.id)),
    });
    if (!section) throw new NotFoundError("Section not on shared document");
  } else if (input.target.kind === "decision") {
    const dec = await db.query.decisions.findFirst({
      where: and(eq(decisions.id, input.target.id), eq(decisions.docId, doc.id)),
    });
    if (!dec) throw new NotFoundError("Decision not on shared document");
  } else if (input.target.kind === "task") {
    const w = await db.query.tasks.findFirst({
      where: and(eq(tasks.id, input.target.id), eq(tasks.docId, doc.id)),
    });
    if (!w) throw new NotFoundError("Task not on shared document");
  }

  // std-8 (spec-156 W3 ac-22): an external commenter writes a doc_comments row
  // scoped to doc.memexId — that's tenant content, so it must emit comment/created
  // on the unified bus exactly like services/comments.ts addComment, otherwise the
  // host Memex's live SSE stream never wakes for share-link comments. The
  // withSeqRetry stays INSIDE the mutate() callback (seq allocation is part of the
  // write); mutate emits once on the returned row.
  return mutate(
    ctx,
    { memexId: doc.memexId, docId: doc.id, entity: "comment", action: "created" },
    async () =>
      withSeqRetry(
        async () => {
          const seq = await nextSeq(
            docComments,
            docComments.seq,
            docComments.docId,
            doc.id,
          );
          const [created] = await db
            .insert(docComments)
            .values({
              memexId: doc.memexId, // scoped to the doc's memex for visibility
              docId: doc.id,
              seq,
              sectionId: input.target.kind === "section" ? input.target.id : null,
              decisionId: input.target.kind === "decision" ? input.target.id : null,
              taskId: input.target.kind === "task" ? input.target.id : null,
              authorName: input.authorName,
              authorUserId: input.authorUserId,
              authorNamespaceId: input.authorNamespaceId,
              content: input.content,
            })
            .returning();
          return created;
        },
        DOC_COMMENTS_SEQ_CONSTRAINT,
      ),
  );
  }); // end runWithMemexId
}

