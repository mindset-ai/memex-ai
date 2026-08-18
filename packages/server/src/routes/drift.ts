// GET /api/drift — Standards Drift Inbox endpoint (t-10 of doc-8; scoped to
// Standards in b-63). Optional `?doc=std-N` narrows to a single standard.
//
// The inbox returns every open `drift` and `plan_revision` typed comment on a
// Standard, with parent doc + section context attached so the React UI can
// render the inbox in one round-trip. It is READ-ONLY: the Inbox carries no
// action controls (spec-143 dec-3 removed them deliberately — accepting a
// proposal is a judgement, not a one-click yes/no).
//
// There is NO accept endpoint here. `POST /proposals/:commentId/accept` existed
// from spec-63 t-12 until spec-530 dec-6 deleted it: it applied a proposal with
// `updateSection`, which has thrown on every Standard since spec-161 made them
// clause-backed, so it could not succeed on any real proposal — and no client
// ever called it. Accepting goes through `accept_standard_change`
// (services/standard-accept.ts), which the drift agent calls behind its
// confirmation gate. If a future Spec revisits spec-143 dec-3 and adds a UI
// control, it adds an HTTP route THEN, against that verb.
//
// Memex scoping is handled by sessionMiddleware (resolves the user's
// current memex from the session JWT + path-resolved memex);
// service-layer guards re-assert the memex_id filter in SQL.

import { Hono } from "hono";
import { sessionMiddleware, type SessionEnv } from "../middleware/session.js";
import type { MemexResolverEnv } from "../middleware/memex-resolver.js";
import { requireMemexId } from "./shared.js";
import { listDriftInbox } from "../services/drift-inbox.js";
import { ValidationError } from "../types/errors.js";

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

export default drift;
