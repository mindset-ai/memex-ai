// API tests for GET /api/live — the PUBLIC spec-458 aggregate — REAL Postgres.
//
// The route mounts with NO session middleware (that absence is the contract,
// ac-17): an anonymous in-process request must succeed, carry the cache +
// noindex headers, and return aggregates only. LIVE_PAGE_ENABLED=false must
// 404 indistinguishably from a missing route (std-7 posture, ac-7/ac-17).

import { describe, it, expect, afterEach } from "vitest";
import { tagAc } from "@memex-ai-ac/vitest";
import { Hono } from "hono";
import { vi } from "vitest";
import { live } from "./live.js";
import { __resetLiveStatsCache } from "../services/live-stats.js";

const AC = "mindset-prod/memex-building-itself/specs/spec-458/acs";

function buildApp(): Hono {
  const app = new Hono();
  app.route("/api/live", live);
  return app;
}

afterEach(() => {
  vi.unstubAllEnvs();
  __resetLiveStatsCache();
});

describe("GET /api/live — public aggregate (ac-17)", () => {
  it("serves an anonymous request: 200, aggregates-only shape, cache + noindex headers", async () => {
    tagAc(`${AC}/ac-17`);
    tagAc(`${AC}/ac-7`);
    const res = await buildApp().request("/api/live");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("public, max-age=15");
    expect(res.headers.get("x-robots-tag")).toBe("noindex");

    const body = (await res.json()) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual([
      "config",
      "generatedAt",
      "geoSource",
      "lastHour",
      "now",
      "points",
      "ticker",
      "totals",
    ]);
    expect(body.config).toMatchObject({ headcountFloor: 25, mapWindowHours: 24 });
  });

  it("LIVE_PAGE_ENABLED=false 404s — indistinguishable from no route (kill switch, ac-7)", async () => {
    tagAc(`${AC}/ac-7`);
    tagAc(`${AC}/ac-17`);
    tagAc(`${AC}/ac-20`);
    vi.stubEnv("LIVE_PAGE_ENABLED", "false");
    const res = await buildApp().request("/api/live");
    expect(res.status).toBe(404);
  });
});
