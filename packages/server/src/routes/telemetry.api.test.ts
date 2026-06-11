// API tests for POST /telemetry (spec-244 t-2) — REAL Postgres.
//
// Drives the route end-to-end (real recordUsageEvent → real usage_events) with a
// stubbed tenant context, asserting the capture posture: authenticated capture,
// anonymous no-op, the registry allowlist, no outcome-spoofing, and server-side
// prop sanitisation.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { tagAc } from "@memex-ai-ac/vitest";
import { Hono } from "hono";
import { createMiddleware } from "hono/factory";
import { and, eq } from "drizzle-orm";
import { db } from "../db/connection.js";
import { usageEvents } from "../db/schema.js";
import { makeTestMemex } from "../services/test-helpers.js";
import { upsertUserByEmail } from "../services/users.js";
import { makeTestAppWithTenant } from "./route-test-helpers.js";
import { telemetryRouter } from "./telemetry.js";

const AC = "mindset-prod/memex-building-itself/specs/spec-244/acs";

let memexId: string;
let userId: string;

beforeAll(async () => {
  memexId = await makeTestMemex("teleapi");
  const u = await upsertUserByEmail(`teleapi-${Date.now()}@memex.ai`);
  userId = u.id;
});

afterAll(async () => {
  await db.delete(usageEvents).where(eq(usageEvents.memexId, memexId));
});

function authedApp(): Hono {
  const app = makeTestAppWithTenant({ memexId, userId });
  app.route("/telemetry", telemetryRouter);
  return app;
}

// Anonymous: behind publicSessionMiddleware, `user` is unset but a memex is still
// resolved from the path. The handler must no-op.
function anonApp(): Hono {
  const app = new Hono();
  app.use(
    "*",
    createMiddleware(async (c, next) => {
      c.set("currentMemexId", memexId);
      return next();
    }),
  );
  app.route("/telemetry", telemetryRouter);
  return app;
}

function post(app: Hono, body: unknown): Promise<Response> {
  return app.request("/telemetry", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function rowsFor(name: string) {
  return db
    .select()
    .from(usageEvents)
    .where(and(eq(usageEvents.memexId, memexId), eq(usageEvents.name, name)));
}

describe("POST /telemetry — front-end capture (ac-3 / ac-7 / ac-8)", () => {
  it("records a registered front-end event, sanitising content out of props", async () => {
    tagAc(`${AC}/ac-3`);
    tagAc(`${AC}/ac-7`);
    const res = await post(authedApp(), {
      name: "cta.clicked",
      props: { id: "new_spec", note: "x".repeat(200), email: "a@b.com", count: 2 },
    });
    expect(res.status).toBe(204);

    const rows = await rowsFor("cta.clicked");
    expect(rows.length).toBe(1);
    expect(rows[0].source).toBe("frontend");
    expect(rows[0].actorUserId).toBe(userId);
    // Content + email-shaped props dropped server-side; ids/counts kept.
    expect(rows[0].props).toEqual({ id: "new_spec", count: 2 });
  });

  it("no-ops for an anonymous caller — 204, no row (ac-7)", async () => {
    tagAc(`${AC}/ac-7`);
    const res = await post(anonApp(), { name: "spec.create_clicked" });
    expect(res.status).toBe(204);
    expect((await rowsFor("spec.create_clicked")).length).toBe(0);
  });

  it("rejects an unregistered event name — 422, no row (ac-3)", async () => {
    tagAc(`${AC}/ac-3`);
    const res = await post(authedApp(), { name: "totally.made_up" });
    expect(res.status).toBe(422);
    expect((await rowsFor("totally.made_up")).length).toBe(0);
  });

  it("refuses to let a client spoof a back-end OUTCOME event — 422, no row (ac-7)", async () => {
    tagAc(`${AC}/ac-7`);
    // document.created is a registered name but source='backend' — only the dec-8
    // whitelist off the real mutate() path may produce it. The route must reject it.
    const res = await post(authedApp(), { name: "document.created" });
    expect(res.status).toBe(422);
    expect((await rowsFor("document.created")).length).toBe(0);
  });

  it("is advisory: a malformed body 400s without throwing or side effects (ac-8)", async () => {
    tagAc(`${AC}/ac-8`);
    const res = await authedApp().request("/telemetry", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{ not json",
    });
    expect(res.status).toBe(400);
  });
});
