import { Hono } from "hono";
import { sessionMiddleware, type SessionEnv } from "../middleware/session.js";
import type { MemexResolverEnv } from "../middleware/memex-resolver.js";
import { requireMemexId } from "./shared.js";
import { ValidationError } from "../types/errors.js";
import { getPlanReadinessBatch } from "../services/execution_plans.js";

type Env = MemexResolverEnv & SessionEnv;
const executionPlans = new Hono<Env>();

executionPlans.use("/*", sessionMiddleware);

// POST /api/execution-plans/readiness
//
// Batched lookup that replaces the N per-work-item fetches a list-style UI would
// otherwise have to do (per t-19 W2). Body shape: `{ taskIds: string[] }`. Returns
// `PlanReadinessEntry[]` — one entry per task that exists in this account; cross-
// tenant ids are silently dropped.
//
// Why POST: the array of UUIDs can be long enough that a `?taskIds=…` query string
// runs into URL-length limits. A POST body is the safer envelope and matches the rest of
// the batched-lookup conventions in the codebase.
//
// std-5 exemption: this router mounts under both /api/<ns>/<mx>/execution-plans
// (path-prefixed) and the flat /api/execution-plans (entity-keyed UUID lookup).
// In the flat case, the memex is resolved per-task via the task FK — cross-tenant
// taskIds are dropped server-side by getPlanReadinessBatch — so no namespace prefix
// is needed for the request to be unambiguous.
executionPlans.post("/readiness", async (c) => {
  const memexId = requireMemexId(c);
  const body = (await c.req.json().catch(() => null)) as
    | { taskIds?: unknown }
    | null;
  const ids = body?.taskIds;
  if (!Array.isArray(ids)) {
    throw new ValidationError("Body must include a 'taskIds' string array");
  }
  for (const id of ids) {
    if (typeof id !== "string") {
      throw new ValidationError("taskIds entries must be strings");
    }
  }
  const result = await getPlanReadinessBatch(memexId, ids as string[]);
  return c.json(result);
});

export { executionPlans };
