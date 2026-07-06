// spec-458 — PUBLIC live-stats endpoint behind memex.ai/live (PROTOTYPE).
//
// Mounted flat with NO session middleware (the /api/health pattern): the
// response is global aggregates + a templated ticker with nothing tenant-scoped
// or user-generated in it, so there is nothing to authorize (ac-1/ac-2).
//
// Kill switch (ac-7): LIVE_PAGE_ENABLED=false 404s the surface entirely —
// indistinguishable from the route not existing (std-7 posture).

import { Hono } from "hono";
import { getLiveStats } from "../services/live-stats.js";

const live = new Hono();

function livePageEnabled(): boolean {
  return process.env.LIVE_PAGE_ENABLED !== "false";
}

live.get("/", async (c) => {
  if (!livePageEnabled()) return c.notFound();
  const stats = await getLiveStats();
  // Edge/browser cacheable for the poll cadence — the process-local TTL cache
  // already bounds DB cost; this bounds request cost.
  c.header("Cache-Control", "public, max-age=15");
  // dec-4 (ac-8/ac-12): the surface is unlisted — keep the JSON out of indexes too.
  c.header("X-Robots-Tag", "noindex");
  return c.json(stats);
});

export { live };
