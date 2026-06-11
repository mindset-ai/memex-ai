// POST /telemetry — the front-end engagement capture endpoint (spec-244 t-2).
//
// The browser posts a REGISTERED event name plus minimal props. The server derives
// the acting user + memex from the session (never trusted from the client),
// validates the name against the registry allowlist (front-end events only — a
// forked client cannot inject content-bearing or back-end OUTCOME events), drops
// any content-shaped props, and records a usage_events row.
//
// Posture (spec-244):
//   - Anonymous → no-op 204 (ac-7). No user, no event.
//   - Advisory  → a failure never breaks the request (ac-8); recordUsageEvent
//                 swallows DB errors, and a bad payload 4xxs without side effects.
//   - Allowlist → only registry FRONT-END names are accepted (ac-3 / ac-7).
//
// Mounted with the PERMISSIVE publicSessionMiddleware (anonymous reaches the
// handler, then no-ops) at /api/:namespace/:memex/telemetry in app.ts.

import { Hono } from "hono";
import { z } from "zod";
import { isFrontendEvent, isRegisteredEvent, sanitizeUsageProps } from "@memex/shared";
import { recordUsageEvent } from "../services/usage-events.js";
import type { SessionEnv } from "../middleware/session.js";
import type { MemexResolverEnv } from "../middleware/memex-resolver.js";

type Env = MemexResolverEnv & SessionEnv;

const bodySchema = z.object({
  name: z.string().min(1).max(120),
  props: z.record(z.string(), z.unknown()).optional(),
  // Client-observed occurrence time (ISO-8601). Optional — defaults to insert time.
  occurredAt: z.string().datetime().optional(),
});

const telemetry = new Hono<Env>();

telemetry.post("/", async (c) => {
  // Anonymous or memex-less → no-op (ac-7). Telemetry only records for an
  // authenticated user inside a resolved memex.
  const user = c.get("user");
  const memexId = c.get("currentMemexId") as string | null;
  if (!user || !memexId) return c.body(null, 204);

  // Malformed payload → 400 with no side effect (advisory; never throws onward).
  let body: z.infer<typeof bodySchema>;
  try {
    body = bodySchema.parse(await c.req.json());
  } catch {
    return c.body(null, 400);
  }

  // Server allowlist (ac-3 / ac-7): only REGISTERED FRONT-END events. Back-end
  // outcome names (document.created, …) are produced solely by the dec-8 whitelist
  // off the real mutate() path — a client cannot spoof them here.
  if (!isRegisteredEvent(body.name) || !isFrontendEvent(body.name)) {
    return c.json({ error: `unregistered event: ${body.name}` }, 422);
  }

  // recordUsageEvent is advisory (swallows its own failures), so the await here
  // can never reject into the response. Props are sanitised server-side regardless
  // of what the client sent (content structurally cannot land).
  await recordUsageEvent({
    memexId,
    actorUserId: user.id,
    // spec-254 — stamp the identity join key when a consented client carried it
    // (read from the cookie by visitorMiddleware). Null otherwise.
    visitorId: c.get("visitorId") ?? null,
    name: body.name,
    source: "frontend",
    props: sanitizeUsageProps(body.props),
    occurredAt: body.occurredAt ? new Date(body.occurredAt) : undefined,
  });

  return c.body(null, 204);
});

export const telemetryRouter = telemetry;
