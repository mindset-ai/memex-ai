import { Hono } from "hono";
import {
  sessionMiddleware,
  publicSessionMiddleware,
  type SessionEnv,
} from "../middleware/session.js";
import type { MemexResolverEnv } from "../middleware/memex-resolver.js";
import { resolveReadableMemexId } from "./shared.js";
import {
  specsOverTime,
  specsByPhase,
  phaseDurations,
  pipelineFunnel,
  activityByActor,
  acVerification,
  acsOverTime,
  testRunVolume,
} from "../services/analytics.js";
import { standardsGraph, DEFAULT_SEMANTIC_THRESHOLD } from "../services/standards-graph.js";
import { ValidationError } from "../types/errors.js";

// ── Spec analytics (spec-179) ────────────────────────────────────────────────
//
// GET /api/<ns>/<mx>/analytics/* — chart-shaped aggregates for the Insights
// page. Read-only; aggregation happens in SQL (services/analytics.ts) so the
// browser never sees raw document rows.
//
// Tenancy mirrors routes/activity.ts: memexResolver + the permissive public
// session resolve the memexId (public Memexes readable, private → 404 per
// std-7). Mutating verbs (none today) stay strict so a future write can never
// be reached anonymously.

type Env = MemexResolverEnv & SessionEnv;
const analytics = new Hono<Env>();

analytics.on("GET", "/*", publicSessionMiddleware);
analytics.on(["POST", "PUT", "PATCH", "DELETE"], "/*", sessionMiddleware);

// GET /analytics/specs-over-time — per-day created + cumulative (ac-1).
analytics.get("/specs-over-time", async (c) => {
  const memexId = await resolveReadableMemexId(c);
  return c.json({ points: await specsOverTime(memexId) });
});

// GET /analytics/specs-by-phase — cumulative per current phase, stacked (ac-2).
analytics.get("/specs-by-phase", async (c) => {
  const memexId = await resolveReadableMemexId(c);
  return c.json({ points: await specsByPhase(memexId) });
});

// GET /analytics/phase-durations — in-phase ages + draft→done cycle time (ac-2).
analytics.get("/phase-durations", async (c) => {
  const memexId = await resolveReadableMemexId(c);
  return c.json(await phaseDurations(memexId));
});

// GET /analytics/pipeline-funnel — specs at-or-beyond each phase.
analytics.get("/pipeline-funnel", async (c) => {
  const memexId = await resolveReadableMemexId(c);
  return c.json({ stages: await pipelineFunnel(memexId) });
});

// GET /analytics/activity-by-actor — per-day Pulse activity split by actor
// kind (reads + test-event spam excluded; see services/analytics.ts).
analytics.get("/activity-by-actor", async (c) => {
  const memexId = await resolveReadableMemexId(c);
  return c.json({ points: await activityByActor(memexId) });
});

// GET /analytics/ac-verification — memex-wide AC verification rollup.
analytics.get("/ac-verification", async (c) => {
  const memexId = await resolveReadableMemexId(c);
  return c.json(await acVerification(memexId));
});

// GET /analytics/acs-over-time — cumulative ACs created vs first-verified.
analytics.get("/acs-over-time", async (c) => {
  const memexId = await resolveReadableMemexId(c);
  return c.json({ points: await acsOverTime(memexId) });
});

// GET /analytics/test-run-volume — per-day test emissions by status.
analytics.get("/test-run-volume", async (c) => {
  const memexId = await resolveReadableMemexId(c);
  return c.json({ points: await testRunVolume(memexId) });
});

// GET /analytics/standards-graph — nodes + mention edges (clause_refs joins,
// ac-11) + semantic-similarity edges from the standards-section embeddings
// (ac-13). `semanticThreshold` (0..1, default 0.5) floors the overlay.
analytics.get("/standards-graph", async (c) => {
  const memexId = await resolveReadableMemexId(c);
  const raw = c.req.query("semanticThreshold");
  let semanticThreshold = DEFAULT_SEMANTIC_THRESHOLD;
  if (raw !== undefined) {
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0 || n > 1) {
      throw new ValidationError("Query param 'semanticThreshold' must be a number in [0, 1]");
    }
    semanticThreshold = n;
  }
  return c.json(await standardsGraph(memexId, { semanticThreshold }));
});

export { analytics };
