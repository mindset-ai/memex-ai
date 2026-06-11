// Unit tests for visitorMiddleware (spec-254 t-2) — the pure-reader server arm.
//
// No DB: a tiny probe app mounts the middleware and echoes c.get("visitorId").
// Asserts it reads the cookie / ?aid, validates UUIDs, prefers the cookie, and
// NEVER sets a cookie of its own (pure reader, dec-4=B).

import { describe, it, expect } from "vitest";
import { tagAc } from "@memex-ai-ac/vitest";
import { Hono } from "hono";
import { randomUUID } from "node:crypto";
import { visitorMiddleware, VISITOR_COOKIE } from "./visitor.js";

const AC = "mindset-prod/memex-building-itself/specs/spec-254/acs";

function probeApp() {
  const app = new Hono();
  app.use("*", visitorMiddleware);
  app.get("/probe", (c) => c.json({ visitorId: c.get("visitorId") ?? null }));
  return app;
}

describe("visitorMiddleware — pure reader (ac-7 server arm, ac-8)", () => {
  it("exposes a UUID visitor_id from the .memex.ai cookie on the context", async () => {
    tagAc(`${AC}/ac-7`);
    const id = randomUUID();
    const res = await probeApp().request("/probe", {
      headers: { cookie: `${VISITOR_COOKIE}=${id}` },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ visitorId: id });
    // Pure reader: never sets a cookie of its own.
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("adopts an inbound ?aid= when there is no cookie (the marketing handoff)", async () => {
    tagAc(`${AC}/ac-8`);
    const id = randomUUID();
    const res = await probeApp().request(`/probe?aid=${id}`);
    expect(await res.json()).toEqual({ visitorId: id });
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("prefers the cookie over ?aid when both are present", async () => {
    tagAc(`${AC}/ac-8`);
    const cookieId = randomUUID();
    const aidId = randomUUID();
    const res = await probeApp().request(`/probe?aid=${aidId}`, {
      headers: { cookie: `${VISITOR_COOKIE}=${cookieId}` },
    });
    expect(await res.json()).toEqual({ visitorId: cookieId });
  });

  it("ignores a malformed (non-UUID) cookie or ?aid — undefined on context", async () => {
    tagAc(`${AC}/ac-7`);
    const res1 = await probeApp().request("/probe", {
      headers: { cookie: `${VISITOR_COOKIE}=not-a-uuid` },
    });
    expect(await res1.json()).toEqual({ visitorId: null });
    const res2 = await probeApp().request("/probe?aid=also-bad");
    expect(await res2.json()).toEqual({ visitorId: null });
  });

  it("is a no-op (undefined) for an anonymous request with no cookie or aid", async () => {
    tagAc(`${AC}/ac-7`);
    const res = await probeApp().request("/probe");
    expect(await res.json()).toEqual({ visitorId: null });
  });
});
