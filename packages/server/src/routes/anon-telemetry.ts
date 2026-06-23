// POST /api/telemetry — the ANONYMOUS-capable, tenant-less engagement ingress
// (spec-324 — the spec-244 retrofit).
//
// The tenant-scoped /api/:ns/:mx/telemetry route no-ops anonymous callers
// (spec-244 ac-7): it requires a user AND a resolved memex. That is correct for
// in-app events, but it makes the FUNNEL HEAD invisible — a visitor seeing the
// signup form has neither a user nor a tenant. This flat sibling records that
// pre-identity event keyed on the consent-gated visitor_id (read from the
// .memex.ai cookie by visitorMiddleware), so the visitor's pre-auth activity is
// captured and later STITCHED to their user at sign-in (identity.merged →
// Mixpanel Simplified ID Merge). When a session IS present it attributes to the
// user too (and still stamps the visitor_id, so an authed event carries both ids
// and Mixpanel merges the device).
//
// Identity: actorUserId from the optional session (PERMISSIVE
// publicSessionMiddleware), visitorId from the cookie. At least one must be
// present — a caller with NEITHER (no consent, no session) is a 204 no-op, so no
// orphaned row ever lands. memex_id is NULL by nature (no tenant).
//
// Allowlist + sanitise exactly like the tenant route: only REGISTERED FRONT-END
// names are accepted, and props are stripped of content/PII server-side.

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
  const visitorId = c.get("visitorId") ?? null;
  // No identity at all — nothing to attribute, and recording a row with neither
  // an actor nor a visitor would be a dead orphan. No-op (advisory, like the
  // tenant route's anonymous no-op).
  if (!user && !visitorId) return c.body(null, 204);

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
