// b-90 — server-side cross-namespace reject + fail-closed-on-unset behaviour.
//
// Covers:
//   ac-5: POST /api/test-events rejects refs whose namespace doesn't match
//         MEMEX_OWN_NAMESPACE, with the correct canonical destination URL
//         in the response body.
//   ac-7: when MEMEX_OWN_NAMESPACE is unset, every POST returns 4xx with no
//         row inserted.
//   ac-8: the 4xx body when unset names the missing env var + remediation.
//
// Built against the Hono route handler directly via Hono's testClient, with
// MEMEX_OWN_NAMESPACE manipulated per-test via process.env. The route reads
// the env var at request time (not module init), so changing the env per
// test works.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Hono } from "hono";
import { tagAc } from "@memex-ai-ac/vitest";

// Mock the DB layer so the route's `db.insert(...)` calls don't hit a real
// database during this test. We only care about the request-shaping logic
// (fail-closed / cross-namespace reject); the happy-path insert is covered
// by other test_events tests.
const insertSpy = vi.fn().mockReturnValue({
  values: vi.fn().mockReturnValue({
    returning: vi.fn().mockResolvedValue([
      { id: "fake-uuid", createdAt: new Date() },
    ]),
  }),
});

vi.mock("../db/connection.js", () => ({
  db: {
    insert: () => insertSpy(),
    // spec-162: the happy-path emission now writes inside db.transaction().
    transaction: (cb: (tx: { insert: () => unknown }) => unknown) =>
      cb({ insert: () => insertSpy() }),
  },
}));

// spec-162: summary maintenance is no-op'd here (covered against a real DB in
// test-event-latest.integration.test.ts); this suite owns namespace-guard behaviour.
vi.mock("../services/test-event-latest.js", () => ({
  applyEmissionToSummary: vi.fn().mockResolvedValue(undefined),
}));

// spec-129: the route now requires a valid emission key (checked AFTER the 503
// server-identity gate, per ac-9). Stub the auth path so this b-90 regression suite keeps
// exercising the fail-closed + cross-namespace behaviour it owns; the 503 tests fire
// before auth either way, and the cross-namespace 400 sits after auth.
vi.mock("../services/emission-keys.js", () => ({
  verifyEmissionKey: vi.fn().mockResolvedValue({ id: "key-1", memexId: "memex-1" }),
  resolveMemexId: vi.fn().mockResolvedValue("memex-1"),
  bumpLastUsed: vi.fn(),
}));

import { testEventsRouter } from "../routes/test-events.js";

const app = new Hono();
app.route("/api/test-events", testEventsRouter);

let priorOwn: string | undefined;

beforeEach(() => {
  priorOwn = process.env.MEMEX_OWN_NAMESPACE;
  insertSpy.mockClear();
});

afterEach(() => {
  if (priorOwn === undefined) {
    delete process.env.MEMEX_OWN_NAMESPACE;
  } else {
    process.env.MEMEX_OWN_NAMESPACE = priorOwn;
  }
});

const validBody = (acUid: string) => ({
  ac_uid: acUid,
  status: "pass",
  test_identifier: "tests/regression.test.ts::it works",
  duration_ms: 12,
});

describe("b-90 ac-7: fail-closed when MEMEX_OWN_NAMESPACE is unset", () => {
  it("returns 4xx for any request when the env var is unset", async () => {
    tagAc("mindset-prod/memex-building-itself/briefs/b-90/acs/ac-7");
    delete process.env.MEMEX_OWN_NAMESPACE;
    const res = await app.request("/api/test-events", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer mxk_test" },
      body: JSON.stringify(validBody("mindset-prod/memex-app/briefs/b-1/acs/ac-1")),
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(600);
  });

  it("does NOT insert a test_events row when the env var is unset", async () => {
    tagAc("mindset-prod/memex-building-itself/briefs/b-90/acs/ac-7");
    delete process.env.MEMEX_OWN_NAMESPACE;
    await app.request("/api/test-events", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer mxk_test" },
      body: JSON.stringify(validBody("mindset-prod/memex-app/briefs/b-1/acs/ac-1")),
    });
    expect(insertSpy).not.toHaveBeenCalled();
  });
});

describe("b-90 ac-8: the 4xx body names the missing env var + remediation", () => {
  it("body mentions MEMEX_OWN_NAMESPACE and how to fix", async () => {
    tagAc("mindset-prod/memex-building-itself/briefs/b-90/acs/ac-8");
    delete process.env.MEMEX_OWN_NAMESPACE;
    const res = await app.request("/api/test-events", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer mxk_test" },
      body: JSON.stringify(validBody("mindset-prod/memex-app/briefs/b-1/acs/ac-1")),
    });
    const body = (await res.json()) as { error?: string; message?: string };
    expect(JSON.stringify(body)).toMatch(/MEMEX_OWN_NAMESPACE/);
    // The remediation should at minimum tell the developer to set it.
    expect(JSON.stringify(body)).toMatch(/set/i);
  });
});

describe("b-90 ac-5: cross-namespace events are rejected with the correct destination in the body", () => {
  it("rejects when the ref names a different namespace from the server's own", async () => {
    tagAc("mindset-prod/memex-building-itself/briefs/b-90/acs/ac-5");
    process.env.MEMEX_OWN_NAMESPACE = "mindset-int";
    const res = await app.request("/api/test-events", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer mxk_test" },
      body: JSON.stringify(validBody("mindset-prod/memex-app/briefs/b-1/acs/ac-1")),
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });

  it("the 4xx body names the correct canonical destination for the ref's namespace", async () => {
    tagAc("mindset-prod/memex-building-itself/briefs/b-90/acs/ac-5");
    process.env.MEMEX_OWN_NAMESPACE = "mindset-int";
    const res = await app.request("/api/test-events", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer mxk_test" },
      body: JSON.stringify(validBody("mindset-prod/memex-app/briefs/b-1/acs/ac-1")),
    });
    const body = (await res.json()) as { error?: string; message?: string; expectedDestination?: string };
    expect(body.error).toBe("wrong-namespace");
    expect(body.expectedDestination).toBe("https://memex.ai/api/test-events");
  });

  it("does NOT insert a row when the ref names a wrong namespace", async () => {
    tagAc("mindset-prod/memex-building-itself/briefs/b-90/acs/ac-5");
    process.env.MEMEX_OWN_NAMESPACE = "mindset-int";
    await app.request("/api/test-events", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer mxk_test" },
      body: JSON.stringify(validBody("mindset-prod/memex-app/briefs/b-1/acs/ac-1")),
    });
    expect(insertSpy).not.toHaveBeenCalled();
  });

  it("accepts matching-namespace events and inserts a row", async () => {
    tagAc("mindset-prod/memex-building-itself/briefs/b-90/acs/ac-5");
    process.env.MEMEX_OWN_NAMESPACE = "mindset-prod";
    const res = await app.request("/api/test-events", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer mxk_test" },
      body: JSON.stringify(validBody("mindset-prod/memex-app/briefs/b-1/acs/ac-1")),
    });
    expect(res.status).toBe(201);
    expect(insertSpy).toHaveBeenCalledTimes(1);
  });
});
