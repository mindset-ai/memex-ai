// HTTP routes for the Standard clause-coverage view in the React UI (spec-151 t-7).
//
// Tenant-scoped (mounted under /api/:namespace/:memex/standards in app.ts). The
// GET resolves the readable memex (public read / private 404 via
// resolveReadableMemexId, std-7) and defers to services/clause-coverage.ts.
//
// Endpoints:
//   GET /doc/:docId/clause-coverage — per-clause coverage + verification for a
//     standard (which clauses have ≥1 test, latest green, CI-backed vs local),
//     plus the aggregate counts (denominator = testable obligations). Mirrors
//     the AC tab's GET /acs/doc/:docId.

import { Hono } from "hono";
import { listClausesForStandardWithVerification } from "../services/clause-coverage.js";
import { type SessionEnv } from "../middleware/session.js";
import type { MemexResolverEnv } from "../middleware/memex-resolver.js";
import { resolveReadableMemexId } from "./shared.js";
import { mountStandardSessionPolicy } from "./session-policy.js";

type Env = MemexResolverEnv & SessionEnv;

const standardsRouter = new Hono<Env>();
mountStandardSessionPolicy(standardsRouter);

standardsRouter.get("/doc/:docId/clause-coverage", async (c) => {
  const memexId = await resolveReadableMemexId(c);
  const docId = c.req.param("docId");
  const coverage = await listClausesForStandardWithVerification(memexId, docId);
  return c.json(coverage);
});

export { standardsRouter };
