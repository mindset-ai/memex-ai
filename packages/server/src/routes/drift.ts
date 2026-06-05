// GET /api/drift — Standards Drift Inbox endpoint (t-10 of doc-8; scoped to
// Standards in b-63). Optional `?doc=std-N` narrows to a single standard.
// POST /api/drift/proposals/:commentId/accept — apply a plan_revision (t-12).
//
// The inbox returns every open `drift` and `plan_revision` typed comment on a
// Standard, with parent doc + section context attached so the React UI can
// render the inbox in one round-trip.
//
// Accepting a proposal: the standard owner clicks Accept on a `plan_revision`
// comment in the inbox; the server parses the proposed-content fence out of
// the comment body, updates the section, and resolves the comment in one
// transaction. Rejecting is just `POST /api/comments/:id/resolve` (existing
// surface), so we don't add a separate endpoint for that.
//
// Memex scoping is handled by sessionMiddleware (resolves the user's
// current memex from the session JWT + path-resolved memex);
// service-layer guards re-assert the memex_id filter in SQL.

import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { db } from "../db/connection.js";
import { docComments } from "../db/schema.js";
import { sessionMiddleware, type SessionEnv } from "../middleware/session.js";
import type { MemexResolverEnv } from "../middleware/memex-resolver.js";
import { requireMemexId } from "./shared.js";
import { listDriftInbox } from "../services/drift-inbox.js";
import { parseProposedChangeBody } from "../services/standards.js";
import { updateSection } from "../services/sections.js";
import { resolveComment } from "../services/comments.js";
import { NotFoundError, ValidationError } from "../types/errors.js";

type Env = MemexResolverEnv & SessionEnv;
const drift = new Hono<Env>();
drift.use("/*", sessionMiddleware);

drift.get("/", async (c) => {
  const memexId = requireMemexId(c);
  const limitParam = c.req.query("limit");
  const cursor = c.req.query("cursor") ?? null;
  // `?doc=std-N` narrows the inbox to a single standard (the drift-badge
  // deep-link). Unknown handles match nothing — empty page, no leak (std-7).
  const docHandle = c.req.query("doc") ?? null;
  const limit = limitParam ? Number.parseInt(limitParam, 10) : undefined;
  if (limitParam !== undefined && (limit === undefined || Number.isNaN(limit))) {
    throw new ValidationError(`Invalid limit '${limitParam}' — must be a positive integer.`);
  }
  const page = await listDriftInbox(memexId, { limit, cursor, docHandle });
  return c.json({ items: page.items, nextCursor: page.nextCursor });
});

// std-5 exemption: comment-UUID lookup. The memex is derived from the comment
// entity's FK; the route works at the flat path even when the caller has
// multiple memberships (the comment row itself ties it to a single memex).
drift.post("/proposals/:commentId/accept", async (c) => {
  const memexId = requireMemexId(c);
  const commentId = c.req.param("commentId");

  const comment = await db.query.docComments.findFirst({
    where: eq(docComments.id, commentId),
  });
  if (!comment || comment.memexId !== memexId) {
    throw new NotFoundError(`Proposal ${commentId} not found`);
  }
  if (comment.commentType !== "plan_revision") {
    throw new ValidationError(
      `Comment ${commentId} is a ${comment.commentType} comment, not a plan_revision proposal.`,
    );
  }
  if (comment.resolvedAt) {
    throw new ValidationError("Proposal is already resolved");
  }
  if (!comment.sectionId) {
    throw new ValidationError(
      "Proposal isn't anchored to a section — cannot apply.",
    );
  }

  const parsed = parseProposedChangeBody(comment.content);
  if (!parsed) {
    throw new ValidationError(
      "Proposal body is missing the proposed-content block; cannot extract replacement text.",
    );
  }

  await updateSection(memexId, comment.sectionId, parsed.proposed);
  const resolved = await resolveComment(memexId, comment.id, "accepted");

  return c.json({ ok: true, comment: resolved });
});

export default drift;
