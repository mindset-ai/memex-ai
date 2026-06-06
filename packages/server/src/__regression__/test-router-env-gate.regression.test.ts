// spec-172 ac-9 — the env-gated test-only router (/api/__test__/*) is mounted
// ONLY when MEMEX_ANTHROPIC_FAKE=1 (app.ts ~line 320). A production-mode boot
// (the flag unset) must never expose it: every /api/__test__/* path 404s.
//
// app.ts captures `process.env.MEMEX_ANTHROPIC_FAKE` at MODULE-LOAD time inside
// the top-level `if (... === "1")` block — so to flip the gate we must set the
// env var, `vi.resetModules()`, and re-import the app fresh for each posture.
// Same technique the backstage/cli-auth integration tests use for
// GOOGLE_CLIENT_ID. We deliberately build the app twice (flag on / flag off) in
// the SAME file and assert the mount appears/disappears with the flag.

import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { tagAc } from "@memex-ai-ac/vitest";

const AC = "mindset-prod/memex-building-itself/specs/spec-172/acs";

const originalFake = process.env.MEMEX_ANTHROPIC_FAKE;

// Build a fresh app with MEMEX_ANTHROPIC_FAKE set to the given value (or unset
// when `value` is undefined). Resets the module registry first so app.ts re-runs
// its top-level gate against the env we just set.
async function buildApp(value: string | undefined) {
  if (value === undefined) delete process.env.MEMEX_ANTHROPIC_FAKE;
  else process.env.MEMEX_ANTHROPIC_FAKE = value;
  vi.resetModules();
  const mod = await import("../app.js");
  return mod.app;
}

beforeEach(() => {
  vi.resetModules();
});

afterAll(() => {
  if (originalFake === undefined) delete process.env.MEMEX_ANTHROPIC_FAKE;
  else process.env.MEMEX_ANTHROPIC_FAKE = originalFake;
  vi.resetModules();
});

describe("spec-172 ac-9: the test-only router is mounted only under its env gate", () => {
  it("production-mode boot (MEMEX_ANTHROPIC_FAKE unset) returns 404 for /api/__test__/*", async () => {
    tagAc(`${AC}/ac-9`);
    const app = await buildApp(undefined);

    // The GET anthropic-queue handler is the simplest read endpoint on the
    // router; if the router were mounted it would respond 200 with a JSON body.
    // With the gate closed Hono has no matching route → 404.
    const res = await app.request("/api/__test__/anthropic-queue");
    expect(res.status).toBe(404);

    // A seed endpoint (POST) is likewise absent — proving the WHOLE router, not
    // just one handler, stays unmounted.
    const seedRes = await app.request("/api/__test__/seed-org", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ownerEmail: "x@example.com", slug: "x" }),
    });
    expect(seedRes.status).toBe(404);
  });

  it("MEMEX_ANTHROPIC_FAKE=1 boot mounts the router (the gate is the only difference)", async () => {
    tagAc(`${AC}/ac-9`);
    const app = await buildApp("1");

    // With the flag set the GET anthropic-queue handler responds — proving the
    // 404 above is the gate, not a missing route. The handler returns the
    // current fake-queue length as JSON.
    const res = await app.request("/api/__test__/anthropic-queue");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { queueLength: number };
    expect(typeof body.queueLength).toBe("number");
  });

  it("a non-'1' value leaves the router unmounted (the gate is strictly === '1')", async () => {
    tagAc(`${AC}/ac-9`);
    // app.ts gates on `=== "1"` exactly — any other truthy-ish string must NOT
    // open the surface. This pins the gate to the documented contract.
    const app = await buildApp("true");
    const res = await app.request("/api/__test__/anthropic-queue");
    expect(res.status).toBe(404);
  });
});
