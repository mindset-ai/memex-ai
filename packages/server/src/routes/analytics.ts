import { Hono } from "hono";
import {
  sessionMiddleware,
  publicSessionMiddleware,
  type SessionEnv,
} from "../middleware/session.js";
import type { MemexResolverEnv } from "../middleware/memex-resolver.js";
import { resolveReadableMemexId } from "./shared.js";
import { specsOverTime, specsByPhase, phaseDurations } from "../services/analytics.js";

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

export { analytics };
