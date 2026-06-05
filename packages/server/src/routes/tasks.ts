import { Hono } from "hono";
import {
  createTask,
  listTasks,
  updateTaskStatus,
  updateTask,
  deleteTask,
  getReadyTasks,
  updateAcceptanceCriteria,
  getTask,
  getTaskByHandle,
} from "../services/tasks.js";
import type { AcceptanceCriterion } from "../services/tasks.js";
import { addBlocker, removeBlocker } from "../services/shared/blockers.js";
import {
  sessionMiddleware,
  publicSessionMiddleware,
  type SessionEnv,
} from "../middleware/session.js";
import type { MemexResolverEnv } from "../middleware/memex-resolver.js";
import { requireMemexId, resolveReadableMemexId } from "./shared.js";

// Public route surface stays at /api/tasks/* — only the underlying service module was
// renamed to tasks per dec-1. New v2 endpoints introduced in later slices use
// the task terminology directly.
type Env = MemexResolverEnv & SessionEnv;
const tasksRouter = new Hono<Env>();
// spec-111 t-10 — per-verb session policy. GET reads permissive (public read /
// private 404 via resolveReadableMemexId); every mutating verb stays strict.
tasksRouter.on("GET", "/*", publicSessionMiddleware);
tasksRouter.on(["POST", "PUT", "PATCH", "DELETE"], "/*", sessionMiddleware);



// t-19 W3.2: comments referencing `[per t-N]` need to resolve account-wide handles
// to the parent doc (analogous to /api/decisions/by-handle/:handle from t-18).
// Routed before /:id so `by-handle` doesn't clash with UUID lookups.
//
// b-42 t-2: `?docId=<uuid>` query optionally scopes the lookup to the parent
// doc. Lets the React UI pass the current doc context for bare `[per t-N]`
// references in section/comment markdown so memexes with multiple Briefs each
// having a t-1 don't 409 on link clicks. When omitted, falls back to the
// original cross-memex lookup which 409s on ambiguity (preserved for
// callers that intentionally want disambiguation behavior).
tasksRouter.get("/by-handle/:handle", async (c) => {
  const memexId = await resolveReadableMemexId(c);
  const handle = c.req.param("handle");
  const docId = c.req.query("docId");
  const result = await getTaskByHandle(memexId, handle, docId);
  return c.json(result);
});

tasksRouter.get("/doc/:docId", async (c) => {
  const memexId = await resolveReadableMemexId(c);
  const docId = c.req.param("docId");
  const result = await listTasks(memexId, docId);
  return c.json(result);
});

tasksRouter.get("/doc/:docId/ready", async (c) => {
  const memexId = await resolveReadableMemexId(c);
  const docId = c.req.param("docId");
  const result = await getReadyTasks(memexId, docId);
  return c.json(result);
});

tasksRouter.post("/doc/:docId", async (c) => {
  const memexId = requireMemexId(c);
  const docId = c.req.param("docId");
  const { title, description, acceptanceCriteria, sectionRef } = await c.req.json<{
    title: string;
    description: string;
    acceptanceCriteria?: AcceptanceCriterion[];
    sectionRef?: string;
  }>();
  const result = await createTask(memexId, docId, title, description, acceptanceCriteria, sectionRef);
  return c.json(result, 201);
});

// std-5 exemption: task-UUID lookup. The memex is derived from the task's FK,
// not the caller's membership set. Flat `/api/tasks/:id/*` stays functional
// for entity-keyed access; multi-membership callers must use the path-prefixed
// mount.
tasksRouter.post("/:id/update", async (c) => {
  const memexId = requireMemexId(c);
  const id = c.req.param("id");
  const body = await c.req.json<{
    title?: string;
    description?: string;
    acceptanceCriteria?: AcceptanceCriterion[];
    sectionRef?: string | null;
  }>();
  const result = await updateTask(memexId, id, body);
  return c.json(result);
});

tasksRouter.delete("/:id", async (c) => {
  const memexId = requireMemexId(c);
  const id = c.req.param("id");
  const result = await deleteTask(memexId, id);
  return c.json(result);
});

tasksRouter.post("/:id/criteria", async (c) => {
  const memexId = requireMemexId(c);
  const id = c.req.param("id");
  const { criteria } = await c.req.json<{ criteria: AcceptanceCriterion[] }>();
  const result = await updateAcceptanceCriteria(memexId, id, criteria);
  return c.json(result);
});

tasksRouter.post("/:id/status", async (c) => {
  const memexId = requireMemexId(c);
  const id = c.req.param("id");
  const { status } = await c.req.json<{ status: string }>();
  const result = await updateTaskStatus(memexId, id, status);
  return c.json(result);
});

tasksRouter.post("/:id/blockers", async (c) => {
  const memexId = requireMemexId(c);
  const taskId = c.req.param("id");
  const { blockedBy } = await c.req.json<{ blockedBy: string }>();
  await addBlocker(memexId, taskId, blockedBy);
  const updated = await getTask(memexId, taskId);
  return c.json(updated);
});

tasksRouter.delete("/:id/blockers/:handle", async (c) => {
  const memexId = requireMemexId(c);
  const taskId = c.req.param("id");
  const handle = c.req.param("handle");
  await removeBlocker(memexId, taskId, handle);
  const updated = await getTask(memexId, taskId);
  return c.json(updated);
});

export { tasksRouter };
