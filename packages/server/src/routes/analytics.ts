import { Hono, type Context } from "hono";
import { type SessionEnv } from "../middleware/session.js";
import type { MemexResolverEnv } from "../middleware/memex-resolver.js";
import { resolveReadableMemexId } from "./shared.js";
import { mountStandardSessionPolicy } from "./session-policy.js";
import {
  specsOverTime,
  specsByPhase,
  phaseDurations,
  pipelineFunnel,
  activityByActor,
  acVerification,
  acsOverTime,
  testRunVolume,
  testSignalPulse,
  specPhaseDurations,
  specLifecycleSummary,
  specTaskVelocity,
  specAcVerification,
  specActivityAudit,
} from "../services/analytics.js";
import { standardsGraph, DEFAULT_SEMANTIC_THRESHOLD } from "../services/standards-graph.js";
import { getDoc } from "../services/documents.js";
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

// spec-377 — the standard per-verb session policy (see session-policy.ts).
mountStandardSessionPolicy(analytics);

// Parse a present-but-optional integer query param; throw 400 on a bad value so a
// typo surfaces instead of silently defaulting. Absent → undefined.
function parsePositiveInt(raw: string | undefined, field: string): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
    throw new ValidationError(`Query param '${field}' must be a positive integer`);
  }
  return n;
}
function parseNonNegativeInt(raw: string | undefined, field: string): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) {
    throw new ValidationError(`Query param '${field}' must be a non-negative integer`);
  }
  return n;
}

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

// GET /analytics/test-signal-pulse?windowMinutes=60 — minute-bucketed test
// emission volume over a short rolling window, for the Pulse test-signal
// monitor. The live SSE test_event stream increments on top of this baseline.
analytics.get("/test-signal-pulse", async (c) => {
  const memexId = await resolveReadableMemexId(c);
  const raw = c.req.query("windowMinutes");
  let windowMinutes: number | undefined;
  if (raw !== undefined) {
    const n = Number(raw);
    if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
      throw new ValidationError("Query param 'windowMinutes' must be a positive integer");
    }
    windowMinutes = n;
  }
  return c.json(await testSignalPulse(memexId, { windowMinutes }));
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

// ── Per-spec stats (spec-406) ────────────────────────────────────────────────
//
// GET /api/<ns>/<mx>/analytics/spec/<id>/* — the spec-scoped siblings powering
// the Stats tab. `id` is a spec handle (spec-N) or UUID; getDoc resolves it
// scoped to this memex and 404s an unknown/cross-tenant id (std-7 — dec-6).
// Ungated: no hiddenFeatures check, read-only, public-readable wherever the
// memex is (resolveReadableMemexId).

/** Resolve the readable memexId + the spec's canonical id from the `:id` ref. */
async function resolveSpec(c: Context<Env>): Promise<{ memexId: string; docId: string }> {
  const memexId = await resolveReadableMemexId(c);
  const spec = await getDoc(memexId, c.req.param("id")!);
  return { memexId, docId: spec.id };
}

// GET /analytics/spec/:id/phase-durations — event-series time-in-phase (dec-1, dec-4).
analytics.get("/spec/:id/phase-durations", async (c) => {
  const { memexId, docId } = await resolveSpec(c);
  return c.json(await specPhaseDurations(memexId, docId));
});

// GET /analytics/spec/:id/summary — the lifecycle summary strip (dec-5).
analytics.get("/spec/:id/summary", async (c) => {
  const { memexId, docId } = await resolveSpec(c);
  return c.json(await specLifecycleSummary(memexId, docId));
});

// GET /analytics/spec/:id/task-velocity — created/started/completed + status split.
analytics.get("/spec/:id/task-velocity", async (c) => {
  const { memexId, docId } = await resolveSpec(c);
  return c.json(await specTaskVelocity(memexId, docId));
});

// GET /analytics/spec/:id/ac-verification — spec-scoped donut.
analytics.get("/spec/:id/ac-verification", async (c) => {
  const { memexId, docId } = await resolveSpec(c);
  return c.json(await specAcVerification(memexId, docId));
});

// GET /analytics/spec/:id/activity?showAll&limit&offset — the who/what/when audit (dec-3).
analytics.get("/spec/:id/activity", async (c) => {
  const { memexId, docId } = await resolveSpec(c);
  const rawShow = c.req.query("showAll");
  const showAll = rawShow === "1" || rawShow === "true";
  const limit = parsePositiveInt(c.req.query("limit"), "limit");
  const offset = parseNonNegativeInt(c.req.query("offset"), "offset");
  return c.json(await specActivityAudit(memexId, docId, { showAll, limit, offset }));
});

export { analytics };
