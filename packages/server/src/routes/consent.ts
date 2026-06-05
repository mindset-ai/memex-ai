import { Hono } from "hono";
import { sessionMiddleware, type SessionEnv } from "../middleware/session.js";
import {
  applyConsentDecisions,
  listPendingConsent,
} from "../services/org-consent.js";
import { ValidationError } from "../types/errors.js";

// /api/consent — t-13 of doc-15. Domain-based auto-join consent (std-6).
//
// The React UI hits these on every session start to know whether to render the
// consent dialog. The server NEVER auto-inserts org_memberships from the SSO
// callback anymore — only this route does (after explicit user accept).

export const consentRouter = new Hono<SessionEnv>();

consentRouter.use("*", sessionMiddleware);

// GET /api/consent/pending — orgs the user can join via domain match (and orgs
// where they're a disabled member, surfaced separately for the "contact admin"
// notice). React UI calls this on session start.
consentRouter.get("/pending", async (c) => {
  const user = c.get("user");
  const result = await listPendingConsent(user.id);
  return c.json(result);
});

// POST /api/consent/decisions — apply a batch of consent decisions in one call.
// Body: { decisions: [{ orgId, response: 'accepted'|'declined'|'skipped' }, ...] }
//
// One round-trip for the multi-select dialog. Each decision is idempotent so
// retries are safe.
consentRouter.post("/decisions", async (c) => {
  const user = c.get("user");
  const body = await c.req.json().catch(() => null);
  if (!body || !Array.isArray(body.decisions)) {
    return c.json({ error: "decisions array is required" }, 400);
  }
  const decisions: Array<{ orgId: string; response: "accepted" | "declined" | "skipped" }> = [];
  for (const d of body.decisions) {
    if (
      typeof d?.orgId !== "string" ||
      !["accepted", "declined", "skipped"].includes(d?.response)
    ) {
      return c.json({ error: "Each decision needs { orgId, response }" }, 400);
    }
    decisions.push({ orgId: d.orgId, response: d.response });
  }
  try {
    await applyConsentDecisions(user.id, decisions);
    return c.json({ ok: true });
  } catch (err) {
    if (err instanceof ValidationError) {
      return c.json({ error: err.message }, 400);
    }
    throw err;
  }
});
