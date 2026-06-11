// Post-deploy smoke — PUBLIC tier (b-70 t-6 / dec-1, dec-3 public tier).
//
// These checks hit a deployed live host (SMOKE_BASE_URL) over REAL HTTP via
// `fetch()` — NOT Hono `app.fetch()` against local Postgres (that's __e2e__).
// They are unauthenticated and non-destructive, so they ALWAYS run at the
// deploy tail regardless of whether a smoke token is configured (dec-4).
//
// Run with `make smoke-int` / `make smoke-prod` (which export SMOKE_BASE_URL
// from scripts/deploy-config.sh). Excluded from the default `make test` /
// vitest run so local + CI never hit the network — this suite lives behind
// vitest.smoke.config.ts.
//
// Public paths smoked (std-9 §7): /api/health, /install.sh, SPA index `/`,
// the /mcp auth-challenge (401 without a Bearer token), and /api/share/:token
// with a clearly-invalid token (asserting the public, non-5xx behaviour).

import { describe, it, expect } from "vitest";
import { tagAc } from "@memex-ai-ac/vitest";
import { SMOKE_BASE_URL, SMOKE_MCP_URL, SMOKE_NAMESPACE } from "./smoke-env.js";

describe(`public smoke @ ${SMOKE_BASE_URL}`, () => {
  it("GET /api/health → 200 {status:ok}", async () => {
    const res = await fetch(`${SMOKE_BASE_URL}/api/health`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status?: string };
    expect(body.status).toBe("ok");
  });

  it("GET /install.sh → 200 (shell installer served)", async () => {
    const res = await fetch(`${SMOKE_BASE_URL}/install.sh`);
    expect(res.status).toBe(200);
    const text = await res.text();
    // It's the bootstrap installer, not an SPA fallback or error page.
    expect(text).toMatch(/Memex MCP installer/i);
  });

  it("GET / → 200 text/html (SPA index served by the LB/CDN)", async () => {
    const res = await fetch(`${SMOKE_BASE_URL}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type") ?? "").toMatch(/text\/html/);
  });

  it("POST /mcp without auth → 401 (Bearer challenge)", async () => {
    const res = await fetch(SMOKE_MCP_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toMatch(/Authorization|token/i);
  });

  it("GET /api/share/:token with an invalid token → public non-5xx (404 unknown)", async () => {
    const res = await fetch(
      `${SMOKE_BASE_URL}/api/share/smoke-invalid-token-does-not-exist`,
    );
    // Public reader path: a bad token is a 4xx (404 unknown / 410 revoked),
    // never a 5xx and never an auth wall — the token itself is the access grant.
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(403);
    const body = (await res.json()) as { reason?: string };
    // The route distinguishes unknown vs revoked; an invalid token reads as unknown.
    expect(body.reason).toBe("unknown");
  });

  // spec-244 t-8 (std-17) — the front-end telemetry capture endpoint is deployed
  // and wired. Anonymous POST is a no-op by design (204); an unprovisioned smoke
  // memex resolves to 404. Either way the route must respond WITHOUT a 5xx and
  // without an auth wall — proving the deploy carried the route and it handles a
  // body without crashing.
  it("POST /api/<ns>/telemetry (anonymous) → controlled response, never 5xx", async () => {
    tagAc("mindset-prod/memex-building-itself/specs/spec-244/acs/ac-11");
    const res = await fetch(`${SMOKE_BASE_URL}/api/${SMOKE_NAMESPACE}/telemetry`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "spec.create_clicked" }),
    });
    expect(res.status).toBeLessThan(500);
    expect([204, 404]).toContain(res.status);
  });
});
