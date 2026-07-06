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

  // spec-304 t-12 (std-17, ac-28) — the desktop in-app install mint endpoint is
  // deployed and session-gated. We can't mint a real token without a session, so
  // the non-destructive post-deploy check is: an UNAUTHENTICATED POST is rejected
  // 401 (proving the route shipped AND the sessionMiddleware gate is live — a 404
  // here would mean the deploy dropped the route). Mirrors the /mcp 401 challenge.
  it("POST /api/mcp/tokens without auth → 401 (route deployed + session-gated)", async () => {
    tagAc("mindset-prod/memex-building-itself/specs/spec-304/acs/ac-28");
    const res = await fetch(`${SMOKE_BASE_URL}/api/mcp/tokens`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ label: "smoke-should-not-mint" }),
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

  // spec-300 t-9 (std-17) — the Skills list REST surface is deployed and tenant-
  // gated. The GET runs behind the permissive public session and resolves the
  // memex via resolveReadableMemexId (public read / private 404, std-7), so an
  // UNAUTHENTICATED GET against the obvious throwaway namespace responds WITHOUT a
  // 5xx and WITHOUT an auth wall: 200 (a JSON array) if that throwaway memex is
  // public, else 404 (unresolvable / private). Either way it proves the route
  // shipped and its tenancy gate is live — a 404 here for a MISSING route would be
  // indistinguishable, but a 5xx (route mounted but crashing) is caught. Never
  // touches a real namespace (SMOKE_NAMESPACE is the reserved throwaway).
  it("GET /api/<ns>/skills (anonymous, throwaway ns) → controlled response, never 5xx", async () => {
    tagAc("mindset-prod/memex-building-itself/specs/spec-300/acs/ac-4");
    const res = await fetch(`${SMOKE_BASE_URL}/api/${SMOKE_NAMESPACE}/skills`);
    expect(res.status).toBeLessThan(500);
    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(403);
    expect([200, 404]).toContain(res.status);
    // A public list returns a JSON array of skill metadata; a private/missing
    // memex returns the std-7 not-found envelope. Both are valid JSON, non-5xx.
    if (res.status === 200) {
      const body = (await res.json()) as unknown;
      expect(Array.isArray(body)).toBe(true);
    }
  });

  // spec-458 t-6 (std-17, ac-17) — the public /live surface is deployed. Two
  // legs: the aggregate API responds with the expected envelope + the unlisted
  // noindex header, and the /live path serves the SPA shell (not a redirect to
  // www and not a bucket error page). NOTE on status: the apex serves deep links
  // as index.html WITH A 404 STATUS (pre-existing platform behaviour, observed
  // on /login and tenant paths alike — the spec-225 latent finding), so the
  // page leg asserts the BODY is the SPA shell rather than pinning 200.
  it("GET /api/live → 200 aggregate envelope + noindex (unlisted, kill switch off)", async () => {
    tagAc("mindset-prod/memex-building-itself/specs/spec-458/acs/ac-17");
    const res = await fetch(`${SMOKE_BASE_URL}/api/live`);
    expect(res.status).toBe(200);
    expect(res.headers.get("x-robots-tag")).toBe("noindex");
    const body = (await res.json()) as Record<string, unknown>;
    for (const key of ["now", "lastHour", "totals", "ticker", "points", "config"]) {
      expect(body).toHaveProperty(key);
    }
  });

  it("GET /live → serves the SPA shell on this host (no redirect to www, no bucket error)", async () => {
    tagAc("mindset-prod/memex-building-itself/specs/spec-458/acs/ac-17");
    const res = await fetch(`${SMOKE_BASE_URL}/live`, { redirect: "manual" });
    // Must NOT be the apex→www 301 (only bare / and marketing paths redirect).
    expect([301, 302, 307, 308]).not.toContain(res.status);
    expect(res.headers.get("content-type") ?? "").toMatch(/text\/html/);
    const text = await res.text();
    // The SPA index, not a GCS error page (status may be 404 per the
    // pre-existing deep-link behaviour; browsers render the app regardless).
    expect(text).toMatch(/<div id="root">|Memex\.AI/);
  });
});
