// POST /api/telemetry — the ANONYMOUS-capable, tenant-less engagement ingress
// (spec-324; reworked by spec-367).
//
// The tenant-scoped /api/:ns/:mx/telemetry route no-ops anonymous callers
// (spec-244 ac-7): it requires a user AND a resolved memex. That is correct for
// in-app events, but it makes the FUNNEL HEAD invisible — a visitor seeing the
// signup form has neither a user nor a tenant. This flat sibling records that
// pre-identity event.
//
// spec-367 (reversing spec-254 dec-4): pre-signup capture is IDENTIFIER-LESS volume
// under legitimate interest. A caller with NEITHER a session NOR a visitor_id is no
// longer a no-op — we record the event with a NULL actor and NULL visitor_id (pure
// count). The visitor_id is still READ (dormant — visitorMiddleware retained per
// spec-367 dec-5) and stamped IF ever present, so the door to a future
// anonymous→user stitch stays open; today nothing mints one, so it is always null.
// memex_id is NULL by nature (no tenant).
//
// Allowlist + sanitise exactly like the tenant route: only REGISTERED FRONT-END
// names are accepted, and props are stripped of content/PII server-side — so an
// identifier-less row can only ever carry a registered event name + safe props.

import { Hono } from "hono";
import { z } from "zod";
import { isFrontendEvent, isRegisteredEvent, sanitizeUsageProps } from "@memex/shared";
import { recordUsageEvent } from "../services/usage-events.js";
import type { SessionEnv } from "../middleware/session.js";

const bodySchema = z.object({
  name: z.string().min(1).max(120),
  props: z.record(z.string(), z.unknown()).optional(),
  // Client-observed occurrence time (ISO-8601). Optional — defaults to insert time.
  occurredAt: z.string().datetime().optional(),
});

const anonTelemetry = new Hono<SessionEnv>();

anonTelemetry.post("/", async (c) => {
  const user = c.get("user");
  // visitorId is dormant (spec-367 dec-5): nothing mints one today, so this is
  // effectively always null. Read + stamped anyway so a future stitch needs no
  // change here. An identifier-less caller (no session, no visitor_id) is recorded
  // as pure volume — NOT a no-op — per spec-367.
  const visitorId = c.get("visitorId") ?? null;

  // Malformed payload → 400 with no side effect.
  let body: z.infer<typeof bodySchema>;
  try {
    body = bodySchema.parse(await c.req.json());
  } catch {
    return c.body(null, 400);
  }

  // Same allowlist as the tenant route: only REGISTERED FRONT-END names. A forked
  // client cannot inject back-end OUTCOME names (they're produced solely by the
  // mutate() whitelist) or unregistered content-bearing events.
  if (!isRegisteredEvent(body.name) || !isFrontendEvent(body.name)) {
    return c.json({ error: `unregistered event: ${body.name}` }, 422);
  }

  // recordUsageEvent is advisory (swallows its own failures); props are sanitised
  // server-side regardless of what the client sent. memex_id is NULL by nature.
  await recordUsageEvent({
    memexId: null,
    actorUserId: user?.id ?? null,
    visitorId,
    name: body.name,
    source: "frontend",
    props: sanitizeUsageProps(body.props),
    occurredAt: body.occurredAt ? new Date(body.occurredAt) : undefined,
  });

  return c.body(null, 204);
});

export const anonTelemetryRouter = anonTelemetry;
