import { Hono } from "hono";
import { assign, unassign, listAssignees } from "../services/doc-assignees.js";
import { sessionMiddleware, publicSessionMiddleware, type SessionEnv } from "../middleware/session.js";
import type { MemexResolverEnv } from "../middleware/memex-resolver.js";
import { requireMemexId, resolveReadableMemexId } from "./shared.js";

// Thin REST mirror of the assignment service (spec-118 t-4). Assignment is the
// live responsibility pointer the board shows (dec-3); GET is permissive (the
// board renders assignees for any reader), mutating verbs strict. assign/unassign
// emit on the unified bus (ac-20) so the board updates live via spec-16.
type Env = MemexResolverEnv & SessionEnv;
const docAssigneesRouter = new Hono<Env>();
docAssigneesRouter.on("GET", "/*", publicSessionMiddleware);
docAssigneesRouter.on(["POST", "PUT", "PATCH", "DELETE"], "/*", sessionMiddleware);

docAssigneesRouter.get("/doc/:docId", async (c) => {
  const memexId = await resolveReadableMemexId(c);
  const docId = c.req.param("docId");
  return c.json(await listAssignees(memexId, docId));
});

// Assign a user to a Spec. `assigned_by` is the authenticated caller.
docAssigneesRouter.post("/doc/:docId/assign", async (c) => {
  const memexId = requireMemexId(c);
  const docId = c.req.param("docId");
  const body = await c.req.json<{ userId?: string }>().catch(() => ({}) as { userId?: string });
  const assignedBy = (c.get("currentUserId") as string | null) ?? null;
  // Self-assign when userId is omitted ("Assign me" needs no client-side id).
  const userId = body.userId ?? assignedBy;
  if (!userId) return c.json({ error: "userId required" }, 400);
  const result = await assign(memexId, docId, userId, assignedBy);
  return c.json(result, 201);
});

docAssigneesRouter.post("/doc/:docId/unassign", async (c) => {
  const memexId = requireMemexId(c);
  const docId = c.req.param("docId");
  const { userId } = await c.req.json<{ userId: string }>();
  if (!userId) return c.json({ error: "userId required" }, 400);
  const result = await unassign(memexId, docId, userId);
  return c.json(result);
});

export { docAssigneesRouter };
