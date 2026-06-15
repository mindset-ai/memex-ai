import { Hono } from "hono";
import {
  addComment,
  addAnchoredComment,
  deleteComment,
  listComments,
  addDecisionComment,
  listDecisionComments,
  addTaskComment,
  listTaskComments,
  listCommentsForDoc,
  resolveComment,
  unresolveComment,
  type CommentExtras,
  type ListCommentsOptions,
} from "../services/comments.js";
import {
  COMMENT_TYPES,
  isCommentType,
  type CommentType,
} from "../types/roles.js";
import { ValidationError } from "../types/errors.js";
import {
  sessionMiddleware,
  publicSessionMiddleware,
  type SessionEnv,
} from "../middleware/session.js";
import type { MemexResolverEnv } from "../middleware/memex-resolver.js";
import { requireMemexId, resolveReadableMemexId } from "./shared.js";
import { restCtx } from "./_actor-ctx.js";

type Env = MemexResolverEnv & SessionEnv;
const comments = new Hono<Env>();
// spec-111 t-10 — per-verb session policy. GET reads permissive (public read /
// private 404 via resolveReadableMemexId); every mutating verb stays strict.
comments.on("GET", "/*", publicSessionMiddleware);
comments.on(["POST", "PUT", "PATCH", "DELETE"], "/*", sessionMiddleware);

// Build a CommentExtras from the raw JSON body, returning undefined when nothing
// typed-comment-related was supplied. Returning undefined preserves the existing
// `addComment(memexId, sectionId, authorName, content)` 4-arg call for clients that
// don't use typed comments — important because routes/comments.test.ts asserts on the
// exact arg list.
//
// doc-26 t-5: the legacy opaque (referenceType, referenceId) text pair is gone.
// Clients now pass whichever of the four structured fields applies — each accepts
// a UUID or a handle (doc-N / std-N / D-N / T-N), resolved by the service layer.
function extractExtras(body: Record<string, unknown>): CommentExtras | undefined {
  const {
    type,
    source,
    referenceBriefId,
    referenceStandardId,
    referenceDecisionId,
    referenceTaskId,
  } = body;
  if (
    type === undefined &&
    source === undefined &&
    referenceBriefId === undefined &&
    referenceStandardId === undefined &&
    referenceDecisionId === undefined &&
    referenceTaskId === undefined
  ) {
    return undefined;
  }
  return {
    type: type as CommentExtras["type"],
    source: source as CommentExtras["source"],
    referenceBriefId: referenceBriefId as CommentExtras["referenceBriefId"],
    referenceStandardId: referenceStandardId as CommentExtras["referenceStandardId"],
    referenceDecisionId: referenceDecisionId as CommentExtras["referenceDecisionId"],
    referenceTaskId: referenceTaskId as CommentExtras["referenceTaskId"],
  };
}

// Parse the optional ?type=… query param into a typeFilter for list/review endpoints.
// Accepts either a single type or a comma-separated list — anything invalid returns 400.
function parseTypeFilter(raw: string | undefined): CommentType[] | undefined {
  if (!raw) return undefined;
  const parts = raw.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
  if (parts.length === 0) return undefined;
  for (const p of parts) {
    if (!isCommentType(p)) {
      throw new ValidationError(
        `Invalid comment type filter '${p}'. Must be one of: ${COMMENT_TYPES.join(", ")}`,
      );
    }
  }
  return parts as CommentType[];
}

comments.get("/doc/:docId", async (c) => {
  const memexId = await resolveReadableMemexId(c);
  const docId = c.req.param("docId");
  const typeFilter = parseTypeFilter(c.req.query("type"));
  const opts: ListCommentsOptions = typeFilter ? { typeFilter } : {};
  const result = await listCommentsForDoc(memexId, docId, opts);
  return c.json(result);
});

comments.get("/section/:sectionId", async (c) => {
  const memexId = await resolveReadableMemexId(c);
  const sectionId = c.req.param("sectionId");
  const typeFilter = parseTypeFilter(c.req.query("type"));
  const opts: ListCommentsOptions = typeFilter ? { typeFilter } : {};
  const result = await listComments(memexId, sectionId, opts);
  return c.json(result);
});

comments.post("/section/:sectionId", async (c) => {
  const memexId = requireMemexId(c);
  const sectionId = c.req.param("sectionId");
  const body = await c.req.json();
  const { authorName, content } = body;
  // spec-100: stamp the session user so "delete your own comment" can be
  // enforced later (ownership is by user id, not display name).
  const userId = (c.get("currentUserId") as string | null) ?? null;
  const extras = { ...(extractExtras(body) ?? {}), ...(userId ? { authorUserId: userId } : {}) };
  // spec-100: an `anchorOffset` (character index into the section source = the
  // END of the selection) makes this a geo-comment. An optional
  // `anchorStartOffset` brackets the selection into a RANGE; without it the
  // comment is a single-point anchor at the end offset.
  const anchorOffset = (body as { anchorOffset?: unknown }).anchorOffset;
  if (typeof anchorOffset === "number") {
    const rawStart = (body as { anchorStartOffset?: unknown }).anchorStartOffset;
    const anchorStartOffset = typeof rawStart === "number" ? rawStart : undefined;
    const anchored = await addAnchoredComment(
      memexId,
      sectionId,
      authorName,
      content,
      anchorOffset,
      extras,
      anchorStartOffset,
    );
    return c.json(anchored, 201);
  }
  const comment = await addComment(memexId, sectionId, authorName, content, extras);
  return c.json(comment, 201);
});

comments.get("/decision/:decisionId", async (c) => {
  const memexId = await resolveReadableMemexId(c);
  const decisionId = c.req.param("decisionId");
  const typeFilter = parseTypeFilter(c.req.query("type"));
  const opts: ListCommentsOptions = typeFilter ? { typeFilter } : {};
  const result = await listDecisionComments(memexId, decisionId, opts);
  return c.json(result);
});

comments.post("/decision/:decisionId", async (c) => {
  const memexId = requireMemexId(c);
  const decisionId = c.req.param("decisionId");
  const body = await c.req.json();
  const { authorName, content } = body;
  const extras = extractExtras(body);
  const comment =
    extras !== undefined
      ? await addDecisionComment(memexId, decisionId, authorName, content, extras)
      : await addDecisionComment(memexId, decisionId, authorName, content);
  return c.json(comment, 201);
});

comments.get("/task/:taskId", async (c) => {
  const memexId = await resolveReadableMemexId(c);
  const taskId = c.req.param("taskId");
  const typeFilter = parseTypeFilter(c.req.query("type"));
  const opts: ListCommentsOptions = typeFilter ? { typeFilter } : {};
  const result = await listTaskComments(memexId, taskId, opts);
  return c.json(result);
});

comments.post("/task/:taskId", async (c) => {
  const memexId = requireMemexId(c);
  const taskId = c.req.param("taskId");
  const body = await c.req.json();
  const { authorName, content } = body;
  const extras = extractExtras(body);
  const comment =
    extras !== undefined
      ? await addTaskComment(memexId, taskId, authorName, content, extras)
      : await addTaskComment(memexId, taskId, authorName, content);
  return c.json(comment, 201);
});

// std-5 exemption: comment-UUID lookup. The memex is derived from the
// comment's FK, not the caller's membership set. Flat `/api/comments/:id/*`
// stays functional for entity-keyed access; multi-membership callers must use
// the path-prefixed mount.
comments.post("/:commentId/resolve", async (c) => {
  const memexId = requireMemexId(c);
  const commentId = c.req.param("commentId");
  const body = await c.req.json().catch(() => ({}));
  const comment = await resolveComment(memexId, commentId, body.resolution, restCtx(c));
  return c.json(comment);
});

comments.post("/:commentId/unresolve", async (c) => {
  const memexId = requireMemexId(c);
  const commentId = c.req.param("commentId");
  const comment = await unresolveComment(memexId, commentId);
  return c.json(comment);
});

// spec-100: delete your own comment. Ownership is enforced in the service
// against the session user; a mismatch surfaces as a 403.
comments.delete("/:commentId", async (c) => {
  const memexId = requireMemexId(c);
  const commentId = c.req.param("commentId");
  const userId = (c.get("currentUserId") as string | null) ?? null;
  try {
    const result = await deleteComment(memexId, commentId, userId);
    return c.json(result);
  } catch (err) {
    if (err instanceof ValidationError) {
      return c.json({ error: err.message }, 403);
    }
    throw err;
  }
});

export { comments };
