// API tests for POST /api/telemetry — the ANONYMOUS-capable ingress (spec-324,
// reworked by spec-367) — REAL Postgres.
//
// Drives the flat tenant-less route end-to-end (real recordUsageEvent → real
// usage_events), asserting the funnel-head posture: a PRE-AUTH caller with NO
// identity is recorded as an IDENTIFIER-LESS volume row (spec-367); the registry
// allowlist still gates; an authenticated caller is attributed; and the dormant
// visitor_id is still stamped if one is ever present.

import { describe, it, expect, afterAll } from "vitest";
import { tagAc } from "@memex-ai-ac/vitest";
import { Hono } from "hono";
import { createMiddleware } from "hono/factory";
import { and, eq, isNull } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { db } from "../db/connection.js";
import { usageEvents } from "../db/schema.js";
import { upsertUserByEmail } from "../services/users.js";
import { anonTelemetryRouter } from "./anon-telemetry.js";

const AC = "mindset-prod/memex-building-itself/specs/spec-324/acs";
const AC367 = "mindset-prod/memex-building-itself/specs/spec-367/acs";

// Build a test app whose middleware injects the identity the real
// publicSessionMiddleware + visitorMiddleware would set on the context.
function appWith(ctx: { userId?: string; visitorId?: string }): Hono {
  const app = new Hono();
  app.use(
    "*",
    createMiddleware(async (c, next) => {
      if (ctx.userId) c.set("user", { id: ctx.userId } as never);
      if (ctx.visitorId) c.set("visitorId", ctx.visitorId);
      return next();
    }),
  );
  app.route("/telemetry", anonTelemetryRouter);
  return app;
}

function post(app: Hono, body: unknown): Promise<Response> {
  return app.request("/telemetry", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const createdVisitorIds: string[] = [];
afterAll(async () => {
  for (const v of createdVisitorIds) {
    await db.delete(usageEvents).where(eq(usageEvents.visitorId, v));
  }
  // The identifier-less row (spec-367) carries no visitor_id, so clean it by its
  // unique-to-this-file event name.
  await db
    .delete(usageEvents)
    .where(and(eq(usageEvents.name, "signup.cta_clicked"), isNull(usageEvents.visitorId)));
});

describe("POST /api/telemetry — anonymous-capable ingress (spec-324 ac-8)", () => {
  it("records a pre-auth event keyed on the visitor_id (no user, no memex)", async () => {
    tagAc(`${AC}/ac-8`);
    tagAc(`${AC}/ac-3`); // scope: a visitor seeing the form is captured pre-auth, keyed on visitor_id
    const visitorId = randomUUID();
    createdVisitorIds.push(visitorId);
    const res = await post(appWith({ visitorId }), {
      name: "signup.form_viewed",
      props: { method: "password" },
    });
    expect(res.status).toBe(204);

    const rows = await db.select().from(usageEvents).where(eq(usageEvents.visitorId, visitorId));
    expect(rows.length).toBe(1);
    expect(rows[0].name).toBe("signup.form_viewed");
    expect(rows[0].source).toBe("frontend");
    expect(rows[0].actorUserId).toBeNull(); // pre-auth — no user yet
    expect(rows[0].memexId).toBeNull(); // tenant-less by nature
    expect(rows[0].props).toEqual({ method: "password" });
  });

  it("attributes to the user AND keeps the visitor_id when a session is present (the merge row)", async () => {
    tagAc(`${AC}/ac-8`);
    const visitorId = randomUUID();
    createdVisitorIds.push(visitorId);
    const u = await upsertUserByEmail(`anontele-${Date.now()}@memex.ai`);
    const res = await post(appWith({ userId: u.id, visitorId }), { name: "signup.form_viewed" });
    expect(res.status).toBe(204);

    const rows = await db.select().from(usageEvents).where(eq(usageEvents.visitorId, visitorId));
    expect(rows.length).toBe(1);
    expect(rows[0].actorUserId).toBe(u.id);
    expect(rows[0].visitorId).toBe(visitorId); // both ids → Mixpanel stitches the device
  });

  it("records an IDENTIFIER-LESS row when there is NEITHER a user nor a visitor_id (spec-367 ac-10)", async () => {
    tagAc(`${AC367}/ac-10`);
    tagAc(`${AC367}/ac-3`); // scope: the server records identifier-less anonymous telemetry
    // spec-367: pure pre-signup volume. No session, no visitor_id → still recorded,
    // with null actor / null visitor / null memex. signup.cta_clicked is unique to
    // this case in the file, so afterAll can clean it by name.
    const res = await post(appWith({}), {
      name: "signup.cta_clicked",
      props: { method: "password" },
    });
    expect(res.status).toBe(204);
    const rows = await db
      .select()
      .from(usageEvents)
      .where(
        and(
          eq(usageEvents.name, "signup.cta_clicked"),
          isNull(usageEvents.visitorId),
          isNull(usageEvents.actorUserId),
        ),
      );
    expect(rows.length).toBe(1);
    expect(rows[0].memexId).toBeNull(); // identifier-less: no actor, no visitor, no tenant
    expect(rows[0].source).toBe("frontend");
    expect(rows[0].props).toEqual({ method: "password" });
  });

  it("rejects an unregistered event name — 422, no row", async () => {
    tagAc(`${AC}/ac-8`);
    const visitorId = randomUUID();
    createdVisitorIds.push(visitorId);
    const res = await post(appWith({ visitorId }), { name: "totally.made_up" });
    expect(res.status).toBe(422);
    const rows = await db.select().from(usageEvents).where(eq(usageEvents.visitorId, visitorId));
    expect(rows.length).toBe(0);
  });

  it("drops content / email-shaped props server-side, keeping ids/enums (spec-324 ac-5)", async () => {
    tagAc(`${AC}/ac-5`);
    const visitorId = randomUUID();
    createdVisitorIds.push(visitorId);
    const res = await post(appWith({ visitorId }), {
      name: "signup.form_viewed",
      props: { method: "password", note: "x".repeat(200), email: "a@b.com" },
    });
    expect(res.status).toBe(204);
    const rows = await db.select().from(usageEvents).where(eq(usageEvents.visitorId, visitorId));
    expect(rows.length).toBe(1);
    // Low-cardinality enum kept; free-text + email-shaped values stripped (no PII lands).
    expect(rows[0].props).toEqual({ method: "password" });
  });

  it("refuses a back-end OUTCOME name a client must not spoof — 422, no row", async () => {
    tagAc(`${AC}/ac-8`);
    const visitorId = randomUUID();
    createdVisitorIds.push(visitorId);
    // account.created is registered but source='backend' — the flat ingress accepts
    // only FRONT-END names, exactly like the tenant route.
    const res = await post(appWith({ visitorId }), { name: "account.created" });
    expect(res.status).toBe(422);
    const rows = await db.select().from(usageEvents).where(eq(usageEvents.visitorId, visitorId));
    expect(rows.length).toBe(0);
  });
});
