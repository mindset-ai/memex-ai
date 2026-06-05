import { Hono } from "hono";
import {
  createDecision,
  listDecisions,
  resolveDecision,
  reopenDecision,
  approveDecision,
  rejectDecision,
  getDecisionByHandle,
  AmbiguousDecisionHandleError,
  SpecParentMismatchError,
} from "../services/decisions.js";
import {
  sessionMiddleware,
  publicSessionMiddleware,
  type SessionEnv,
} from "../middleware/session.js";
import type { MemexResolverEnv } from "../middleware/memex-resolver.js";
import { requireMemexId, resolveReadableMemexId } from "./shared.js";

type Env = MemexResolverEnv & SessionEnv;
const decisionsRouter = new Hono<Env>();
// spec-111 t-10 — per-verb session policy. GET reads go behind the permissive
// public session (anonymous-friendly; each handler gates the memex via
// resolveReadableMemexId → public read / private 404). Every mutating verb stays
// strict so a non-member can never reach a write.
decisionsRouter.on("GET", "/*", publicSessionMiddleware);
decisionsRouter.on(["POST", "PUT", "PATCH", "DELETE"], "/*", sessionMiddleware);



// t-18 (UI: standard view + drift indicators) → t-20 W-A (qualified handles)
// → t-7 (Spec-qualified canonical form): standards reference decisions by
// handle without knowing the parent docId. The handle path accepts three forms:
//   - bare              `dec-7`        (legacy; may collide across docs in the
//                                       same account → 409 with candidates)
//   - doc-qualified     `doc-3:dec-7`  (legacy qualified form, t-20 W-A)
//   - Spec-qualified    `mis-3:dec-7`  (NEW canonical, t-7 — same lookup as
//                                       doc-qualified plus a parent-kind
//                                       assertion; 409 if parent isn't a Spec.
//                                       Prefix `mis-` is a pre-Spec historical
//                                       form preserved under b-105 allowlist.)
//
// Routed BEFORE `/:id/resolve` etc. so Hono picks the literal path first;
// `by-handle` is not a valid UUID and not a handle for `:id`, so there's no
// overlap risk. The `:handle` segment Hono URL-decodes for us, so the qualified
// `mis-3%3Adec-7` from the client arrives here as `mis-3:dec-7`.
// b-42 t-2: `?docId=<uuid>` query optionally scopes the lookup to the parent
// doc (mirrors the tasks/by-handle change in the same MR). The React UI passes
// the current doc context for bare `[per dec-N]` references in section /
// comment markdown so memexes with multiple Specs each carrying a dec-1 don't
// 409 on link clicks. Qualified handles (`doc-N:dec-M`, `mis-N:dec-M`) already
// encode the parent and ignore the query.
decisionsRouter.get("/by-handle/:handle", async (c) => {
  const memexId = await resolveReadableMemexId(c);
  const handle = c.req.param("handle");
  const docId = c.req.query("docId");
  try {
    const result = await getDecisionByHandle(memexId, handle, docId);
    return c.json(result);
  } catch (err) {
    // Special-case the disambiguation 409 so the response payload can carry the
    // candidate qualified handles. Other DomainError types fall through to the
    // central error handler (NotFoundError → 404, ValidationError → 400, etc.).
    if (err instanceof AmbiguousDecisionHandleError) {
      return c.json(
        {
          error: err.message,
          code: err.code,
          candidates: err.candidates,
        },
        409,
      );
    }
    // t-7: surface the parent-kind mismatch for `mis-N:dec-M` cites that point
    // at a non-Spec parent. Carries the actual docType so the caller can
    // decide whether to rewrite to `doc-N:dec-M` (legacy) or pick a different
    // Spec.
    if (err instanceof SpecParentMismatchError) {
      return c.json(
        {
          error: err.message,
          code: err.code,
          docHandle: err.docHandle,
          actualDocType: err.actualDocType,
        },
        409,
      );
    }
    throw err;
  }
});

decisionsRouter.get("/doc/:docId", async (c) => {
  const memexId = await resolveReadableMemexId(c);
  const docId = c.req.param("docId");
  // `?include=deleted` opts into the Deleted-tab query path (b-97 scope ac-3).
  // Default is "hide deleted" so legacy callers (Spec board, candidate UI)
  // see exactly what they used to.
  const includeDeleted = c.req.query("include") === "deleted";
  const result = await listDecisions(memexId, docId, { includeDeleted });
  return c.json(result);
});

decisionsRouter.post("/doc/:docId", async (c) => {
  const memexId = requireMemexId(c);
  const docId = c.req.param("docId");
  const { title, context, source } = await c.req.json<{
    title: string;
    context?: string;
    // Optional provenance — defaults to 'human' (the REST surface is human-authored).
    // Agent-driven proposals flow through `propose_decision` (MCP) which sets 'agent'.
    source?: "human" | "agent";
  }>();
  const sourceArg: "human" | "agent" =
    source === "agent" ? "agent" : "human";
  const result = await createDecision(memexId, docId, title, context, sourceArg);
  return c.json(result, 201);
});

// std-5 exemption: decision-UUID lookup. The memex is derived from the
// decision's FK, not the caller's membership set. Flat `/api/decisions/:id/*`
// stays functional for entity-keyed access; multi-membership callers must use
// the path-prefixed mount.
decisionsRouter.post("/:id/resolve", async (c) => {
  const memexId = requireMemexId(c);
  const id = c.req.param("id");
  const { resolution, chosenOptionIndex } = await c.req.json<{
    resolution: string;
    chosenOptionIndex?: number;
  }>();
  // Pass chosenOptionIndex only when supplied — preserves the existing 3-arg call shape
  // for clients that don't use multi-option decisions.
  const result =
    chosenOptionIndex !== undefined
      ? await resolveDecision(memexId, id, resolution, chosenOptionIndex)
      : await resolveDecision(memexId, id, resolution);
  return c.json(result);
});

decisionsRouter.post("/:id/reopen", async (c) => {
  const memexId = requireMemexId(c);
  const id = c.req.param("id");
  const result = await reopenDecision(memexId, id);
  return c.json(result);
});

// t-16: approve/reject endpoints for the candidate workflow. These wrap the
// strict-transition service helpers from t-5 (`candidate → open` / `candidate
// → rejected`). Existing MCP tools (`approve_candidate`, `reject_candidate`)
// already cover the agent surface; these REST endpoints back the human-
// reviewer UI in the candidate decisions tab.
decisionsRouter.post("/:id/approve", async (c) => {
  const memexId = requireMemexId(c);
  const id = c.req.param("id");
  const result = await approveDecision(memexId, id);
  return c.json(result);
});

decisionsRouter.post("/:id/reject", async (c) => {
  const memexId = requireMemexId(c);
  const id = c.req.param("id");
  const { reason } = await c.req.json<{ reason: string }>();
  const result = await rejectDecision(memexId, id, reason);
  return c.json(result);
});

export { decisionsRouter };
