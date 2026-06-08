import { Hono } from "hono";
import {
  resolveRole,
  listEditors,
  promoteToEditor,
  demoteToReviewer,
} from "../services/doc-members.js";
import { sessionMiddleware, publicSessionMiddleware, type SessionEnv } from "../middleware/session.js";
import type { MemexResolverEnv } from "../middleware/memex-resolver.js";
import { requireMemexId, resolveReadableMemexId } from "./shared.js";

// Thin REST mirror of the per-Spec role service (spec-118 t-3). Roles gate
// CAPABILITY + UI posture, never read access (dec-2) — so GET is permissive (the
// posture is computed for any reader, including anonymous → reviewer), and the
// mutating verbs stay strict. The org-level access gate (std-4) is enforced
// upstream by the session/memex-resolver middleware; promotion/demotion is open to
// any active org member, on self or another (dec-5), so there is no finer check.
type Env = MemexResolverEnv & SessionEnv;
const docMembersRouter = new Hono<Env>();
docMembersRouter.on("GET", "/*", publicSessionMiddleware);
docMembersRouter.on(["POST", "PUT", "PATCH", "DELETE"], "/*", sessionMiddleware);

// The editors of a Spec + the caller's own resolved posture. The React UI reads
// `myRole` to choose reviewer vs editor mode and `editors` for the member list.
docMembersRouter.get("/doc/:docId", async (c) => {
  const memexId = await resolveReadableMemexId(c);
  const docId = c.req.param("docId");
  const userId = (c.get("currentUserId") as string | null) ?? null;
  // currentMemexId is set only for confirmed org members; null for anonymous/non-members.
  const isMember = !!(c.get("currentMemexId") as string | null);
  const [editors, myRole] = await Promise.all([
    listEditors(memexId, docId, isMember),
    resolveRole(memexId, docId, userId),
  ]);
  return c.json({ editors, myRole });
});

// Promote a member to editor (self or another). Body `{ userId }` defaults to the
// caller (self-promotion is the common path).
docMembersRouter.post("/doc/:docId/promote", async (c) => {
  const memexId = requireMemexId(c);
  const docId = c.req.param("docId");
  const body = await c.req.json<{ userId?: string }>().catch(() => ({}) as { userId?: string });
  const userId = body.userId ?? (c.get("currentUserId") as string | null);
  if (!userId) return c.json({ error: "userId required" }, 400);
  const result = await promoteToEditor(memexId, docId, userId);
  return c.json(result);
});

// Demote a member to reviewer (self or another). No last-editor lock (dec-5).
docMembersRouter.post("/doc/:docId/demote", async (c) => {
  const memexId = requireMemexId(c);
  const docId = c.req.param("docId");
  const body = await c.req.json<{ userId?: string }>().catch(() => ({}) as { userId?: string });
  const userId = body.userId ?? (c.get("currentUserId") as string | null);
  if (!userId) return c.json({ error: "userId required" }, 400);
  const result = await demoteToReviewer(memexId, docId, userId);
  return c.json(result);
});

export { docMembersRouter };
