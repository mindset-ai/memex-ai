import { Hono } from "hono";
import {
  createIssue,
  listIssuesForSpec,
  getIssue,
  updateIssue,
  updateIssueStatus,
  deleteIssue,
  convertIssueToTask,
  kickTaskToIssue,
  isIssueType,
  isIssueStatus,
  type IssueType,
  type IssueStatus,
} from "../services/issues.js";
import {
  sessionMiddleware,
  publicSessionMiddleware,
  type SessionEnv,
} from "../middleware/session.js";
import type { MemexResolverEnv } from "../middleware/memex-resolver.js";
import { requireMemexId, resolveReadableMemexId } from "./shared.js";

// Thin REST mirror of the Issues service (spec-112 t-10). The React UI's
// IssuePanel talks to this surface exactly as TaskPanel talks to /api/tasks;
// the MCP issue tools (register_issue / list_issues / convert_issue_to_task /
// kick_task_to_issue …) ride the SAME service functions, so there is one
// behaviour, two front doors (s-4, "no new infrastructure").
//
// Per-verb session policy mirrors tasks.ts: GET reads are permissive (public
// read / private 404 via resolveReadableMemexId, std-7); every mutating verb
// stays strict.
type Env = MemexResolverEnv & SessionEnv;
const issuesRouter = new Hono<Env>();
issuesRouter.on("GET", "/*", publicSessionMiddleware);
issuesRouter.on(["POST", "PUT", "PATCH", "DELETE"], "/*", sessionMiddleware);

// List Issues for a Spec, optionally filtered. `?type=bug|todo` and
// `?status=open|converted|resolved|wont_fix` are the REST mirror of the
// list_issues MCP tool's filters — invalid values are ignored (the service
// only narrows on a recognised value), keeping the list permissive.
issuesRouter.get("/doc/:docId", async (c) => {
  const memexId = await resolveReadableMemexId(c);
  const docId = c.req.param("docId");
  const typeQ = c.req.query("type");
  const statusQ = c.req.query("status");
  const filter: { type?: IssueType; status?: IssueStatus } = {};
  if (typeQ && isIssueType(typeQ)) filter.type = typeQ;
  if (statusQ && isIssueStatus(statusQ)) filter.status = statusQ;
  const result = await listIssuesForSpec(memexId, docId, filter);
  return c.json(result);
});

// Author an Issue against a Spec — any phase, no anchor (ac-1 / ac-12). The
// human React UI defaults source:"human"; the service mints the per-Spec issue-N.
issuesRouter.post("/doc/:docId", async (c) => {
  const memexId = requireMemexId(c);
  const docId = c.req.param("docId");
  const { title, body, type, severity } = await c.req.json<{
    title: string;
    body?: string;
    type: IssueType;
    severity?: string | null;
  }>();
  const userId = (c.get("currentUserId") as string | null) ?? null;
  const result = await createIssue({
    memexId,
    docId,
    title,
    body: body ?? "",
    type,
    severity: severity ?? null,
    source: "human",
    createdByUserId: userId,
  });
  return c.json(result, 201);
});

// std-5 exemption: issue-UUID lookup. The memex is derived from the issue's FK.
issuesRouter.post("/:id/update", async (c) => {
  const memexId = requireMemexId(c);
  const id = c.req.param("id");
  const body = await c.req.json<{
    title?: string;
    body?: string;
    severity?: string | null;
  }>();
  const result = await updateIssue(memexId, id, body);
  return c.json(result);
});

issuesRouter.post("/:id/status", async (c) => {
  const memexId = requireMemexId(c);
  const id = c.req.param("id");
  const { status } = await c.req.json<{ status: string }>();
  const result = await updateIssueStatus(memexId, id, status);
  return c.json(result);
});

issuesRouter.delete("/:id", async (c) => {
  const memexId = requireMemexId(c);
  const id = c.req.param("id");
  const result = await deleteIssue(memexId, id);
  return c.json(result);
});

// Down-bridge: Issue → Task (ac-20). REST mirror of convert_issue_to_task.
issuesRouter.post("/:id/convert-to-task", async (c) => {
  const memexId = requireMemexId(c);
  const id = c.req.param("id");
  const result = await convertIssueToTask(memexId, id);
  return c.json(result, 201);
});

// Up-bridge: Task → Issue (ac-30). REST mirror of kick_task_to_issue. Keyed on
// the TASK id (the offending agent Task), with a required offline-work reason.
issuesRouter.post("/from-task/:taskId", async (c) => {
  const memexId = requireMemexId(c);
  const taskId = c.req.param("taskId");
  const { reason } = await c.req.json<{ reason: string }>();
  const result = await kickTaskToIssue(memexId, taskId, reason);
  return c.json(result, 201);
});

// Tenancy-scoped single fetch (std-7: 404 when not in the memex).
issuesRouter.get("/:id", async (c) => {
  const memexId = await resolveReadableMemexId(c);
  const id = c.req.param("id");
  const result = await getIssue(memexId, id);
  return c.json(result);
});

export { issuesRouter };
